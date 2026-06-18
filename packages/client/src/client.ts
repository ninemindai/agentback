// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Runtime client returned by `createClient`. Encapsulates the baseURL,
 * default-header resolver (sync or async — use a function for refreshable
 * auth tokens), and fetch implementation.
 */
export interface Client {
  readonly baseURL: string;
  resolveHeaders(): Promise<Record<string, string>>;
  readonly fetch: typeof globalThis.fetch;
  /** Default timeout applied when a route call doesn't override it. */
  readonly defaultTimeoutMs?: number;
}

export interface ClientConfig {
  /** Base URL for every request (e.g. `http://localhost:3000`). */
  baseURL: string;
  /**
   * Static headers, or a function (sync or async) returning headers. Use
   * the function form for lazy/refreshable auth tokens.
   */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Inject a custom fetch (e.g. for tests or instrumentation). */
  fetch?: typeof globalThis.fetch;
  /**
   * Default request timeout in milliseconds. Applied as an `AbortSignal`
   * unless a per-call `options.timeoutMs` overrides it, or the caller
   * passes their own `options.signal`.
   */
  timeoutMs?: number;
}

export function createClient(config: ClientConfig): Client {
  const baseURL = config.baseURL;
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const headerSrc = config.headers;
  const defaultTimeoutMs = config.timeoutMs;
  return {
    baseURL,
    fetch: fetchImpl,
    defaultTimeoutMs,
    async resolveHeaders() {
      if (!headerSrc) return {};
      if (typeof headerSrc === 'function') return await headerSrc();
      return headerSrc;
    },
  };
}
