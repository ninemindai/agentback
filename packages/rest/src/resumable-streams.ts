// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AbortReasons, abortError, loggers} from '@agentback/common';
import {AgentError, ErrorCodes, buildErrorEnvelope} from '@agentback/openapi';
import type {SchemaLike} from '@agentback/openapi';
import {standardParse} from '@agentback/openapi';
import type {StreamFramer} from './stream-framers.js';

const log = loggers('agentback:rest:resumable');

/** Tuning for a `resumable:` stream route. */
export interface ResumableOptions {
  /**
   * How long the producer keeps running after the client disconnects, waiting
   * for a reconnect. Default 30s. This is the window in which you are paying
   * for work nobody is reading — the whole point of the feature, and its whole
   * cost.
   */
  windowMs?: number;
  /**
   * Ring-buffer cap. Default 1024. A client that misses more than this many
   * events cannot be resumed and is told so explicitly rather than handed a
   * silent gap.
   */
  maxEvents?: number;
}

const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_MAX_EVENTS = 1024;
const DEFAULT_MAX_LIVE_STREAMS = 1000;

/** Seconds a caller refused by the live-stream cap is told to wait. */
export const STREAMS_FULL_RETRY_AFTER_S = 5;

/** Normalize the `resumable:` route option to its tuning record. */
export function resumableOptions(
  value: boolean | ResumableOptions | undefined,
): ResumableOptions {
  return typeof value === 'object' ? value : {};
}

/**
 * The one answer to a `Last-Event-ID` that cannot be honoured — unknown,
 * expired, trimmed out of the ring, or opened on another route or by another
 * principal. One shape for every cause, so a probe learns nothing; a non-200,
 * so `EventSource` stops instead of reconnecting; and never a fresh run, which
 * would be the duplicate agent turn `resumable:` exists to prevent.
 */
export function resumeRefused(): AgentError {
  return new AgentError(
    'Cannot resume: the stream is gone or the requested position has been ' +
      'discarded. Start a new stream without Last-Event-ID.',
    {status: 409},
  );
}

/** A new resumable stream refused because the server-wide cap is reached. */
export function streamsFull(): AgentError {
  return new AgentError(
    'Too many live resumable streams. Retry after the Retry-After interval.',
    {status: 503, code: ErrorCodes.SERVICE_UNAVAILABLE},
  );
}

/** Where framed bytes go: the Express response, or a Web stream controller. */
export interface StreamSink {
  /** False when the transport is full: wait for {@link drain} before more. */
  write(chunk: string): boolean;
  /** Resolves once the transport can take more, or the sink has closed. */
  drain(): Promise<void>;
  close(): void;
}

/**
 * Who may rejoin a stream: the route that opened it, and the principal that
 * opened it (undefined on an unauthenticated route). On an anonymous route the
 * stream id itself is the only credential — a bearer capability.
 */
export interface StreamScope {
  ctor: Function;
  methodName: string;
  owner: string | undefined;
}

/**
 * A request that rejoins a live stream instead of invoking its handler —
 * returned by the resume gate and turned into a response only after the
 * dispatch hooks have run, so their headers land before anything is flushed.
 */
export class Resumption {
  constructor(
    readonly stream: ResumableStream,
    readonly afterSeq: number,
  ) {}
}

/** One already-framed frame, retained so a reconnect can replay it verbatim. */
interface Frame {
  seq: number;
  text: string;
}

/**
 * Split a `Last-Event-ID` value into its stream and sequence halves. The id we
 * put on the wire is `<streamId>.<seq>`, so one standard header carries both —
 * which is what lets a plain `new EventSource(url)` resume with no client code.
 */
export function parseEventId(
  raw: string | undefined,
): {streamId: string; seq: number} | undefined {
  if (!raw) return undefined;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const seq = Number(raw.slice(dot + 1));
  if (!Number.isInteger(seq) || seq < 0) return undefined;
  return {streamId: raw.slice(0, dot), seq};
}

/**
 * A stream whose producer outlives any one connection.
 *
 * The inversion that makes resumption possible: the async iterator is drained
 * by THIS object, not by the response. A connection is a *sink* that attaches
 * and detaches; when none is attached the pump keeps going into the ring
 * buffer. That is why a browser refresh no longer costs an agent turn — and
 * also why an abandoned stream must be bounded by both a window and a cap.
 */
export class ResumableStream {
  readonly id = crypto.randomUUID();
  private seq = 0;
  private readonly frames: Frame[] = [];
  /** Sequence of the oldest frame still buffered; grows as the ring trims. */
  private oldestSeq = 1;
  private sink?: StreamSink;
  /** The attached sink reported full; the pump waits before producing more. */
  private sinkFull = false;
  /** Ends the pump's wait for a full sink — on drain, or when it detaches. */
  private releaseWait?: () => void;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private done = false;
  private disposed = false;
  private readonly windowMs: number;
  private readonly maxEvents: number;

  constructor(
    private readonly iterator: AsyncIterator<unknown>,
    private readonly itemSchema: SchemaLike,
    private readonly framer: StreamFramer,
    /**
     * A resume must present the same route and principal: the stream id is
     * unguessable, but an id that leaks must not hand someone else's agent
     * turn to the finder.
     */
    readonly scope: StreamScope,
    private readonly onDispose: (stream: ResumableStream) => void,
    /**
     * Aborted when an unfinished stream is disposed — window expiry
     * (`RESUME_WINDOW_CLOSED`) or server stop (`CANCELLED`); never on normal
     * completion. This is the `resumable:` rewiring of
     * `CoreBindings.ABORT_SIGNAL`: the handler still gets a "stop now" signal,
     * it is just no longer the socket that decides when.
     */
    private readonly abort: AbortController | undefined,
    options: ResumableOptions = {},
  ) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  /** True once the producer has finished or failed. */
  get finished(): boolean {
    return this.done;
  }

  /** Frame, buffer and (if attached) write one already-validated payload. */
  private push(text: (id: string) => string): void {
    const seq = ++this.seq;
    const frame = {seq, text: text(`${this.id}.${seq}`)};
    this.frames.push(frame);
    if (this.frames.length > this.maxEvents) {
      this.frames.shift();
      this.oldestSeq = this.frames[0]!.seq;
    }
    if (this.sink && !this.sink.write(frame.text)) this.sinkFull = true;
  }

  /**
   * Backpressure: while an attached reader is not keeping up, stop pulling
   * from the producer instead of buffering without limit in the transport.
   * Only an ATTACHED sink paces the pump. A detach (or a new attach, or
   * dispose) ends the wait, so a stream nobody is reading keeps filling its
   * ring for a later resume — the ring, not the socket, bounds that memory.
   */
  private async whileSinkFull(): Promise<void> {
    if (!this.sinkFull || !this.sink) return;
    this.sinkFull = false;
    const sink = this.sink;
    await new Promise<void>(resolve => {
      this.releaseWait = resolve;
      void sink.drain().then(resolve);
    });
    this.releaseWait = undefined;
  }

  /** Validate and emit one item. Returns false when the stream must stop. */
  private emit(item: unknown): boolean {
    const parsed = standardParse(this.itemSchema, item);
    if (!parsed.success) {
      // Parity with the non-resumable path: a stream that lies about its item
      // type must not keep lying.
      log.debug('stream item failed validation: %j', parsed.issues);
      this.push(() =>
        this.framer.error({
          statusCode: 500,
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Stream item failed response validation.',
          details: parsed.issues,
        }),
      );
      return false;
    }
    this.push(id => this.framer.item(parsed.data, id));
    return true;
  }

  /**
   * Drain the iterator to completion, independent of any connection. Never
   * throws: a mid-stream failure becomes a terminal error frame, exactly as
   * the non-resumable path does.
   */
  async pump(first: IteratorResult<unknown>): Promise<void> {
    try {
      if (!first.done && !this.emit(first.value)) return;
      while (!this.disposed) {
        await this.whileSinkFull();
        if (this.disposed) break;
        const {value, done} = await this.iterator.next();
        if (done) break;
        if (!this.emit(value)) break;
      }
    } catch (err) {
      log.debug('stream handler threw mid-stream: %s', (err as Error).message);
      const {issues, ...envelope} = buildErrorEnvelope(err);
      this.push(() =>
        this.framer.error({
          statusCode: envelope.statusCode ?? 500,
          ...envelope,
          ...(issues ? {issues, details: issues} : {}),
        }),
      );
    } finally {
      this.done = true;
      // A stream that finishes while nobody is watching keeps its tail for the
      // grace window: the client that reconnects still gets the ending.
      if (this.sink) this.dispose();
    }
  }

  /**
   * Whether a client that last saw `afterSeq` can rejoin: the stream is still
   * live and that position has not been trimmed out of the ring. False is an
   * unsatisfiable resume, which the caller must refuse rather than paper over.
   */
  canResume(afterSeq: number): boolean {
    return !this.disposed && afterSeq + 1 >= this.oldestSeq;
  }

  /**
   * Attach a connection for as long as `connection` stays live. `afterSeq`
   * replays everything the client missed (check {@link canResume} first);
   * `undefined` is a fresh connection. A connection that is already gone —
   * the client left while the handler was still producing its first item —
   * is detached at once, so the window starts instead of never starting.
   */
  attach(sink: StreamSink, connection: AbortSignal, afterSeq?: number): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.sink = sink;
    this.sinkFull = false;
    this.releaseWait?.();
    if (afterSeq !== undefined) {
      // The replay is bounded by the ring, so it is written in one go; a full
      // sink afterwards still pauses the pump.
      for (const f of this.frames) {
        if (f.seq > afterSeq && !sink.write(f.text)) this.sinkFull = true;
      }
    }
    if (this.done) {
      this.dispose();
      return;
    }
    if (connection.aborted) this.detach(sink);
    else
      connection.addEventListener('abort', () => this.detach(sink), {
        once: true,
      });
  }

  /**
   * The client on `sink` went away. The producer keeps running — that is the
   * bargain of `resumable:` — but only until the window closes. A no-op for a
   * sink that is no longer the attached one: a replaced connection's late
   * close must not detach the client that replaced it.
   */
  detach(sink: StreamSink): void {
    if (sink !== this.sink) return;
    this.sink = undefined;
    this.sinkFull = false;
    this.releaseWait?.();
    if (this.disposed) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.dispose(), this.windowMs);
    this.graceTimer.unref?.();
  }

  /**
   * Stop the producer, end the attached connection, and evict. Idempotent.
   * `reason` reaches the handler's signal only if the producer is unfinished:
   * a stream that completed normally is not an aborted one.
   */
  dispose(reason: string = AbortReasons.RESUME_WINDOW_CLOSED): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    const sink = this.sink;
    this.sink = undefined;
    this.releaseWait?.();
    sink?.close();
    if (!this.done) this.abort?.abort(abortError(reason));
    void this.iterator.return?.()?.catch(err => {
      log.debug('stream iterator return() threw: %s', (err as Error).message);
    });
    this.onDispose(this);
  }
}

/**
 * Live resumable streams for one process.
 *
 * In-memory by design, and therefore single-process: a client that reconnects
 * to a different instance starts a fresh stream. That mirrors
 * `InMemoryEventStore` in `@agentback/mcp-http` — behind a load balancer you
 * want either sticky sessions or a shared implementation of this surface.
 */
export class ResumableStreamRegistry {
  private readonly streams = new Map<string, ResumableStream>();
  /** Slots claimed by requests whose handler has not produced a stream yet. */
  private reserved = 0;

  /**
   * @param maxLiveStreams - server-wide cap on live streams. Not keyed on
   * anything a caller controls, so no caller can dodge it.
   */
  constructor(
    private readonly maxLiveStreams: number = DEFAULT_MAX_LIVE_STREAMS,
  ) {}

  /**
   * Claim a slot for a new stream before its handler runs, or undefined when
   * the registry is full. The slot counts against the cap until the returned
   * release runs (idempotent) — so concurrent requests still waiting on their
   * first item cannot all slip past it. Release once the stream is created or
   * the request fails.
   */
  reserve(): (() => void) | undefined {
    if (this.streams.size + this.reserved >= this.maxLiveStreams) {
      return undefined;
    }
    this.reserved++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.reserved--;
    };
  }

  create(
    iterator: AsyncIterator<unknown>,
    itemSchema: SchemaLike,
    framer: StreamFramer,
    scope: StreamScope,
    abort?: AbortController,
    options?: ResumableOptions,
  ): ResumableStream {
    const stream = new ResumableStream(
      iterator,
      itemSchema,
      framer,
      scope,
      s => this.streams.delete(s.id),
      abort,
      options,
    );
    this.streams.set(stream.id, stream);
    return stream;
  }

  /**
   * The resume gate. Undefined when the request carries no well-formed
   * `Last-Event-ID` (a fresh stream). Otherwise the stream to rejoin — or, for
   * an unknown/expired id, another route's or principal's stream, or a
   * position trimmed out of the ring, a thrown {@link resumeRefused}: the
   * same 409 for every cause, so a probe learns nothing.
   */
  resume(
    lastEventId: string | null | undefined,
    scope: StreamScope,
  ): Resumption | undefined {
    const parsed = parseEventId(lastEventId ?? undefined);
    if (!parsed) return undefined;
    const stream = this.streams.get(parsed.streamId);
    if (!stream || !stream.canResume(parsed.seq)) throw resumeRefused();
    const {ctor, methodName, owner} = stream.scope;
    if (
      ctor !== scope.ctor ||
      methodName !== scope.methodName ||
      owner !== scope.owner
    ) {
      // Never log the id: it is a live credential for the stream.
      log.warn('resume refused: stream belongs to another route or principal');
      throw resumeRefused();
    }
    return new Resumption(stream, parsed.seq);
  }

  /** Stop every live stream. Called on server stop so nothing outlives it. */
  disposeAll(): void {
    for (const stream of [...this.streams.values()]) {
      stream.dispose(AbortReasons.CANCELLED);
    }
  }

  /** Live stream count — for tests and diagnostics. */
  get size(): number {
    return this.streams.size;
  }
}
