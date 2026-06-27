// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Live-reflection bus. Opens the console `/live` SSE stream and fires a
 * `reload` whenever a reconnect returns a NEW boot id (the app restarted).
 * A reconnect to the SAME boot id is a transient blip and is ignored.
 *
 * Framework-agnostic (no React); the console App subscribes and bumps a
 * `reloadNonce` (see App.tsx). Modeled on console-chat's openSseStream, but
 * kept here to avoid a circular dep (console-chat depends on console).
 */

interface MinimalEventSource {
  onmessage: ((ev: {data: unknown}) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}
export type EventSourceFactory = (url: string) => MinimalEventSource;

type ReloadListener = () => void;
type StatusListener = (connected: boolean) => void;

const _reload = new Set<ReloadListener>();
const _status = new Set<StatusListener>();

export function subscribeReload(fn: ReloadListener): () => void {
  _reload.add(fn);
  return () => _reload.delete(fn);
}
export function subscribeStatus(fn: StatusListener): () => void {
  _status.add(fn);
  return () => _status.delete(fn);
}
function emitReload(): void {
  for (const fn of _reload) fn();
}
function emitStatus(connected: boolean): void {
  for (const fn of _status) fn(connected);
}

let _running = false;
let _stop: (() => void) | undefined;

export function startLiveBus(
  url: string,
  options?: {
    reconnectDelayMs?: number;
    eventSourceFactory?: EventSourceFactory;
  },
): () => void {
  if (_running && _stop) return _stop; // idempotent (StrictMode double-mount)
  _running = true;

  const delay = options?.reconnectDelayMs ?? 2000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defaultFactory: EventSourceFactory = (u: string) =>
    new ((globalThis as any).EventSource as new (
      url: string,
    ) => MinimalEventSource)(u);
  const makeEs = options?.eventSourceFactory ?? defaultFactory;

  let bootId: string | null = null;
  let cancelled = false;
  let current: MinimalEventSource | null = null;

  function connect(): void {
    if (cancelled) return;
    const es = makeEs(url);
    current = es;
    es.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type?: string;
          bootId?: string;
        };
        if (msg.type === 'hello' && typeof msg.bootId === 'string') {
          emitStatus(true);
          if (bootId === null) bootId = msg.bootId; // baseline
          else if (msg.bootId !== bootId) {
            bootId = msg.bootId; // restart
            emitReload();
          }
          // same id → blip → no-op
        }
      } catch {
        // malformed frame — ignore
      }
    };
    es.onerror = () => {
      es.close();
      current = null;
      if (cancelled) return;
      emitStatus(false);
      globalThis.setTimeout(connect, delay); // steady retry, resumes on return
    };
  }

  connect();

  _stop = () => {
    cancelled = true;
    current?.close();
    current = null;
    _running = false;
    _stop = undefined;
  };
  return _stop;
}
