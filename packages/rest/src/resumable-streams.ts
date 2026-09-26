// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AbortReasons, abortError, loggers} from '@agentback/common';
import {ErrorCodes, buildErrorEnvelope} from '@agentback/openapi';
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

/** Where framed bytes go: the Express response, or a Web stream controller. */
export interface StreamSink {
  write(chunk: string): void;
  close(): void;
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
     * The principal that opened the stream, or undefined when the route is
     * unauthenticated. A resume must present the same one: the stream id is
     * unguessable, but an id that leaks must not hand someone else's agent
     * turn to the finder.
     */
    readonly owner: string | undefined,
    private readonly onDispose: (stream: ResumableStream) => void,
    /**
     * Aborted when the stream is disposed — window expiry, completion, or
     * server stop. This is the `resumable:` rewiring of
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
    this.sink?.write(frame.text);
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
      if (this.sink) {
        this.sink.close();
        this.dispose();
      }
    }
  }

  /**
   * Attach a connection. `afterSeq` replays everything the client missed;
   * `undefined` is a fresh connection. Returns false when the requested
   * position has already been trimmed out of the ring — an unsatisfiable
   * resume, which the caller must report rather than paper over.
   */
  attach(sink: StreamSink, afterSeq?: number): boolean {
    if (afterSeq !== undefined && afterSeq + 1 < this.oldestSeq) return false;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.sink = sink;
    if (afterSeq !== undefined) {
      for (const f of this.frames) if (f.seq > afterSeq) sink.write(f.text);
    }
    if (this.done) {
      sink.close();
      this.dispose();
    }
    return true;
  }

  /**
   * The client went away. The producer keeps running — that is the bargain of
   * `resumable:` — but only until the window closes.
   */
  detach(): void {
    this.sink = undefined;
    if (this.disposed) return;
    this.graceTimer = setTimeout(() => this.dispose(), this.windowMs);
    this.graceTimer.unref?.();
  }

  /** Stop the producer and evict. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.sink = undefined;
    this.abort?.abort(
      abortError(
        this.done ? AbortReasons.CANCELLED : AbortReasons.RESUME_WINDOW_CLOSED,
      ),
    );
    void this.iterator.return?.();
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

  create(
    iterator: AsyncIterator<unknown>,
    itemSchema: SchemaLike,
    framer: StreamFramer,
    owner: string | undefined,
    abort?: AbortController,
    options?: ResumableOptions,
  ): ResumableStream {
    const stream = new ResumableStream(
      iterator,
      itemSchema,
      framer,
      owner,
      s => this.streams.delete(s.id),
      abort,
      options,
    );
    this.streams.set(stream.id, stream);
    return stream;
  }

  /**
   * Look up a stream for a resume. A principal mismatch answers `undefined` —
   * indistinguishable from an expired stream, so a probe learns nothing.
   */
  resume(
    streamId: string,
    owner: string | undefined,
  ): ResumableStream | undefined {
    const stream = this.streams.get(streamId);
    if (!stream) return undefined;
    if (stream.owner !== owner) {
      log.warn('resume of stream %s refused: principal mismatch', streamId);
      return undefined;
    }
    return stream;
  }

  /** Stop every live stream. Called on server stop so nothing outlives it. */
  disposeAll(): void {
    for (const stream of [...this.streams.values()]) stream.dispose();
  }

  /** Live stream count — for tests and diagnostics. */
  get size(): number {
    return this.streams.size;
  }
}
