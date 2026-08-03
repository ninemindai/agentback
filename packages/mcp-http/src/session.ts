// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  createMcpHandler,
  localhostAllowedOrigins,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  McpHttpHandler,
  McpRequestContext,
} from '@modelcontextprotocol/server';
import {BindingScope, Context} from '@agentback/core';
import {loggers} from '@agentback/common';
import {MCPBindings, MCPServer} from '@agentback/mcp';
import type {McpHttpOptions} from './index.js';

const log = loggers('agentback:mcp-http:session');

/**
 * Populate a per-session DI context before its `MCPServer` is resolved. Bind
 * any user-specific `@mcpServer` tool classes (via `addTool(sessionCtx,
 * ToolClass)`) so they are discovered only for this session/user. May be async
 * (e.g. an entitlement lookup).
 *
 * `request` is a **Web `Request` on every host** — the Express host converts
 * its `IncomingMessage` before calling you, so one binder works everywhere.
 * Read headers with `request.headers.get(name)`.
 *
 * The authenticated principal is **not** on the request: read it from the
 * context you are handed, which is the framework's existing idiom and the only
 * spoof-proof source.
 *
 * ```ts
 * async perSession(ctx) {
 *   const auth = await ctx.get(MCPBindings.REQUEST_AUTH, {optional: true});
 *   if (!auth) return;                       // anonymous -> shared tools only
 *   // NOT `auth.clientId` — under OAuth that is the client APPLICATION id,
 *   // shared by every end user of that app. Use your IdP's subject claim.
 *   for (const T of entitlements.toolsFor(auth.extra?.sub)) addTool(ctx, T);
 * }
 * ```
 *
 * Mutate **only** `sessionCtx`; never reach up to the application context.
 */
export type SessionBinder = (
  sessionCtx: Context,
  request: Request,
) => void | Promise<void>;

/**
 * Build the per-session DI context and resolve its own `MCPServer`.
 *
 * Shared by the Express and fetch hosts so the two cannot drift: before this
 * existed each mount had its own copy, and they disagreed about what the binder
 * receives — the Express host passed an Express `req` while the fetch host
 * passed a Web `Request` behind a cast, so a binder written to the documented
 * signature broke on the edge host.
 *
 * The caller owns the returned context's lifetime: `close()` it when the
 * session ends, and on any throw from here (the binder, schema lowering) the
 * context is closed before rethrowing, since no transport is connected yet.
 */
export async function resolveSessionServer(options: {
  appContext: Context;
  binder: SessionBinder;
  request: Request;
  authInfo?: AuthInfo;
}): Promise<{sessionCtx: Context; mcp: MCPServer}> {
  // Parent on the app context; a SINGLETON binding OWNED by sessionCtx resolves
  // against sessionCtx, so `@inject.context()` hands the new server THIS
  // context — its tool discovery then walks sessionCtx -> app (app config still
  // resolves up the chain), giving one server per session.
  const sessionCtx = new Context(options.appContext, 'mcp.session');
  try {
    // The validated principal, bound under the same key tools inject, so the
    // binder reads identity the one spoof-proof way instead of digging through
    // a host-specific request object.
    if (options.authInfo) {
      sessionCtx.bind(MCPBindings.REQUEST_AUTH).to(options.authInfo);
    }
    await options.binder(sessionCtx, options.request);
    sessionCtx
      .bind(MCPBindings.SERVER.key)
      .toClass(MCPServer)
      .inScope(BindingScope.SINGLETON);
    return {sessionCtx, mcp: await sessionCtx.get(MCPBindings.SERVER)};
  } catch (err) {
    sessionCtx.close();
    throw err;
  }
}

/**
 * Build the `McpServerFactory` that stateless serving hands to
 * `createMcpHandler` — one server per HTTP request, scope-gated by the
 * principal the caller already verified.
 *
 * When a binder is configured, each request also gets its own DI child context
 * (per-request tool discovery, the stateless successor to per-session
 * discovery). **Disposal rides the SDK's own lifetime signal:** it closes the
 * per-request server when the exchange completes — after any streamed progress,
 * and before the response body finishes draining — so `onclose` is the correct
 * point to release the context. Closing when `fetch()` resolves would be far too
 * early: `fetch()` returns before the tool has done any work.
 *
 * The existing handler is chained rather than replaced, so this never clobbers
 * teardown the SDK installed itself.
 */
export function perRequestFactory(options: {
  mcp: MCPServer;
  binder?: SessionBinder;
  appContext?: Context;
  /**
   * Whether the mount authenticates at all. Load-bearing: `buildServer()`
   * skips scope filtering entirely when `scopes` is `undefined`, so an
   * anonymous request under OPTIONAL auth must still pass `[]` (deny scoped
   * tools) rather than nothing (expose them).
   */
  authEnabled?: boolean;
}) {
  return async (ctx: McpRequestContext) => {
    // Mirrors the session path's `authEnabled ? (authInfo?.scopes ?? []) :
    // undefined`. Writing this as `ctx.authInfo ? {...} : {}` looked
    // equivalent and was not: with `strategyAuth: {required: false}` an
    // anonymous caller has no authInfo, fell through to `{}`, and every
    // `@tool({scope})` became visible AND callable — `@tool({scope})` is a
    // visibility gate, so nothing downstream re-checks it.
    const scoped = options.authEnabled
      ? {scopes: ctx.authInfo?.scopes ?? []}
      : {};
    if (!options.binder || !ctx.requestInfo) {
      return options.mcp.buildServer(scoped);
    }
    const {sessionCtx, mcp} = await resolveSessionServer({
      appContext: options.appContext!,
      binder: options.binder,
      request: ctx.requestInfo,
      ...(ctx.authInfo ? {authInfo: ctx.authInfo} : {}),
    });
    const server = mcp.buildServer(scoped);
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      sessionCtx.close();
    };
    return server;
  };
}

/**
 * Normalize configured `Host` / `Origin` allowlist entries to bare hostnames.
 *
 * The two APIs disagree, and forwarding one to the other fails closed but
 * silently. `McpHttpOptions.allowedOrigins` is documented as *Origin header
 * values* (`https://app.example.com`) because that is what the SDK's
 * transport option took. The SDK's standalone validators instead parse the
 * INCOMING header down to a hostname and compare against a list of
 * **hostnames** — so handing them `https://app.example.com` compares
 * `app.example.com` against `['https://app.example.com']`, never matches, and
 * rejects every request.
 *
 * Accepts either form so a user's existing config keeps working:
 * `https://app.example.com`, `mcp.example.com:8080` and `mcp.example.com` all
 * normalize to their hostname. Unparseable entries pass through untouched
 * rather than being dropped — an entry that never matches is safer than one
 * silently removed from an allowlist.
 */
export function toHostnames(values: string[]): string[] {
  return values.map(value => {
    // Already a URL (has a scheme) — take its hostname.
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        return new URL(value).hostname;
    } catch {
      return value;
    }
    // Bare host, possibly with a port.
    try {
      return new URL(`http://${value}`).hostname;
    } catch {
      return value;
    }
  });
}

/** What a CORS config names, split by how precisely it can be matched. */
export interface CorsDeclaration {
  /** Full origins, e.g. `https://app.example.com`. Matched exactly. */
  exact: string[];
  /** Origin patterns. Matched by testing the pattern. */
  patterns: RegExp[];
}

/**
 * The origins a CORS configuration names, or `'any'` when it admits every
 * origin and therefore names no allowlist to reuse.
 *
 * `rest.cors`'s origins already ARE an origin allowlist — the set of browser
 * origins the app says may talk to it — so the `/mcp` rebinding allowlist is
 * derived from them rather than configured a second time.
 *
 * A **RegExp is kept, not discarded**. `cors: {origin: /\.example\.com$/}` is a
 * *restrictive* config; collapsing it to `'any'` (as this once did) gave the
 * least protection to a caller who asked for more than a wildcard did. Regexes
 * are pure, so they can be evaluated per request.
 *
 * A **callback origin still answers `'any'`**. `CustomOrigin` is
 * `(origin, callback) => void` — asynchronous and free to have side effects or
 * depend on request state, so it is not something a transport guard can invoke
 * per request. `origin: true`, `'*'`, and a bare `cors: true` are genuine
 * wildcards and answer `'any'` too; the caller warns rather than guessing.
 */
export function corsDeclaredOrigins(cors: unknown): CorsDeclaration | 'any' {
  const none: CorsDeclaration = {exact: [], patterns: []};
  // No CORS at all: nothing declared, and no cross-origin browser access.
  if (cors === undefined || cors === null || cors === false) return none;
  if (cors === true) return 'any'; // `cors()` defaults to `origin: '*'`
  if (typeof cors !== 'object') return none;
  const {origin} = cors as {origin?: unknown};
  if (origin === undefined || origin === true || origin === '*') return 'any';
  if (origin === false) return none;
  if (typeof origin === 'string') return {exact: [origin], patterns: []};
  if (origin instanceof RegExp) return {exact: [], patterns: [origin]};
  // A function origin is the only remaining non-array shape.
  if (!Array.isArray(origin)) return 'any';
  const declared: CorsDeclaration = {exact: [], patterns: []};
  for (const entry of origin) {
    if (entry instanceof RegExp) {
      declared.patterns.push(entry);
      continue;
    }
    if (typeof entry !== 'string') return 'any'; // a nested callback/boolean
    if (entry === '*') return 'any';
    declared.exact.push(entry);
  }
  return declared;
}

/**
 * One clause of an `Origin` policy. Kept separate by kind because **precision
 * follows the source**: an entry is matched at the precision it was declared
 * at, rather than everything being flattened to hostnames.
 *
 * - `hostname` — port- and scheme-agnostic, via the SDK's `validateOriginHeader`.
 *   Used for explicitly-configured `allowedOrigins` (its documented, shipped
 *   behaviour, which changing would break callers) and for the localhost
 *   defaults (dev servers move ports).
 * - `exact` — full `scheme://host[:port]` equality. Used for origins derived
 *   from CORS, so a precise grant stays precise: naming
 *   `https://app.example.com` must not also admit `http://app.example.com`.
 * - `pattern` — the RegExp the app already trusted for CORS.
 */
export type OriginRule =
  | {kind: 'hostname'; values: string[]}
  | {kind: 'exact'; values: string[]}
  | {kind: 'pattern'; values: RegExp[]};

/** Canonical `scheme://host[:port]` form, or `undefined` if unparseable. */
function canonicalOrigin(value: string): string | undefined {
  try {
    const {origin} = new URL(value);
    // `new URL('app.example.com')` throws, but some inputs parse to the opaque
    // "null" origin (e.g. `data:` URLs); those can never match a real browser
    // Origin and must not become a wildcard.
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * Does this `Origin` header satisfy any rule?
 *
 * A missing or empty header PASSES: only browsers send `Origin`, so an absent
 * one means a non-browser client (MCP client, curl, stdio bridge), which is not
 * what DNS-rebinding defense is aimed at. Every other value must match a rule —
 * including the literal `null` origin browsers send for opaque contexts, which
 * fails because it is not a parseable origin.
 */
export function originAllowed(
  origin: string | null | undefined,
  rules: OriginRule[],
): boolean {
  if (origin === null || origin === undefined || origin === '') return true;
  const canonical = canonicalOrigin(origin);
  for (const rule of rules) {
    switch (rule.kind) {
      case 'hostname':
        if (validateOriginHeader(origin, rule.values).ok) return true;
        break;
      case 'exact':
        if (canonical === undefined) break; // unparseable never matches
        if (rule.values.some(v => canonicalOrigin(v) === canonical))
          return true;
        break;
      case 'pattern':
        if (canonical === undefined) break;
        // Test the canonical origin so a trailing slash or default port in the
        // header cannot dodge a pattern anchored with `$`.
        if (rule.values.some(p => p.test(canonical))) return true;
        break;
    }
  }
  return false;
}

/** Operator-facing summary of what a policy admits, for the rejection log. */
export function describeOriginRules(rules: OriginRule[]): string {
  return (
    rules
      .map(rule =>
        rule.kind === 'pattern'
          ? `matching ${rule.values.map(String).join(', ')}`
          : `${rule.kind} ${rule.values.join(', ')}`,
      )
      .join('; ') || '(nothing)'
  );
}

/** The `Origin` policy decision, plus the warning it earned (if any). */
export interface OriginAllowlistDecision {
  /**
   * Rules to admit by, or `undefined` when no `Origin` check should run at all.
   * Each rule carries its own matching precision — see {@link OriginRule}.
   */
  rules?: OriginRule[];
  /** Emitted by the caller when the outcome deserves operator attention. */
  warning?: string;
}

/**
 * Decide which `Origin` values a stateless `/mcp` mount admits.
 *
 * Origin validation is a spec MUST, not a hardening option: every Streamable
 * HTTP revision since 2025-03-26 says "Servers MUST validate the `Origin`
 * header on all incoming connections to prevent DNS rebinding attacks". So the
 * allowlist defaults ON rather than appearing only when one is configured —
 * "browser-reachable with no allowlist" is the exact combination the guard
 * exists to stop, and since 0.9.0 made this the default mount, reaching it by
 * accident got easy.
 *
 * Safe to default because a MISSING `Origin` passes by design (see
 * `validateOriginHeader`): only browsers send the header, so no MCP client,
 * curl, or stdio bridge is affected. The only request that can newly fail is a
 * browser one — which is the case being defended.
 *
 * The allowlist comes from `rest.cors` rather than being configured twice:
 * those origins already state which browsers may call the app. When CORS
 * admits *any* origin there is nothing to enumerate, and the outcome then
 * depends on whether protection was asked for by name:
 *
 * - asked for explicitly (`enableDnsRebindingProtection: true`) → fall back to
 *   localhost, because an explicit `true` must never become a silent no-op;
 * - left to the default → no allowlist, and a warning. Locking a wide-open
 *   CORS app down to localhost would break the browser client its own config
 *   admits, which is not a default's call to make.
 *
 * **Precision follows the source.** A CORS origin is matched exactly and a CORS
 * regex is tested, so a grant stays as narrow as the app declared it; only the
 * localhost defaults and an explicitly-configured `allowedOrigins` use
 * hostname matching (the latter because that is its shipped, documented
 * behaviour and narrowing it would break callers who already set it).
 *
 * Stateless-only by construction: the session transport exact-matches the raw
 * `Origin` header against `allowedOrigins`, so a derived `localhost` would 403
 * a browser on `http://localhost:3000` there.
 * {@link setupStateless} returns before calling this on the session path.
 */
export function deriveOriginAllowlist(
  options: Pick<
    McpHttpOptions,
    'allowedOrigins' | 'corsConfig' | 'enableDnsRebindingProtection'
  >,
): OriginAllowlistDecision {
  if (options.allowedOrigins !== undefined) {
    // Hostname matching, deliberately: this option shipped with those
    // semantics and tightening it now would 403 callers who already set it.
    return {
      rules: [{kind: 'hostname', values: toHostnames(options.allowedOrigins)}],
    };
  }
  const declared = corsDeclaredOrigins(options.corsConfig);
  if (declared !== 'any') {
    const rules: OriginRule[] = [
      {kind: 'hostname', values: localhostAllowedOrigins()},
    ];
    if (declared.exact.length) {
      rules.push({kind: 'exact', values: declared.exact});
    }
    if (declared.patterns.length) {
      rules.push({kind: 'pattern', values: declared.patterns});
    }
    return {rules};
  }
  if (options.enableDnsRebindingProtection === true) {
    return {
      rules: [{kind: 'hostname', values: localhostAllowedOrigins()}],
      warning:
        'DNS-rebinding protection was requested explicitly but `cors` admits ' +
        'any origin, so no allowlist could be derived from it. Admitting ' +
        'localhost only — set `allowedOrigins` to your real browser ' +
        'origin(s) to widen it.',
    };
  }
  return {
    warning:
      'MCP endpoint is browser-reachable with NO Origin validation: `cors` ' +
      'admits any origin, so no allowlist could be derived from it. The ' +
      'Streamable HTTP spec requires servers to validate `Origin` ' +
      '(DNS-rebinding defense) — set `allowedOrigins` to your real browser ' +
      'origin(s).',
  };
}

/**
 * Remediation text returned in the 403 body when an `Origin` is refused.
 *
 * The body, not the log, is the channel that actually reaches the person
 * debugging: framework logs are `debug`-namespaced and emit nothing unless
 * `DEBUG` is set, while a browser developer is already looking at the failed
 * request. Deliberately does NOT enumerate the allowlist — that detail goes to
 * the log, where the reader is the operator rather than the caller.
 */
export const ORIGIN_REJECTED_HINT =
  'Origin not allowed. This endpoint validates `Origin` to prevent DNS ' +
  'rebinding, as the MCP Streamable HTTP spec requires. If this client is ' +
  'legitimate, add its origin to `allowedOrigins` (or to `rest.cors`, which ' +
  'the default allowlist is derived from).';

/**
 * Build a deduplicating reporter for rejected `Origin` values.
 *
 * A derived allowlist can 403 a browser the operator never explicitly
 * excluded, and the SDK's rejection is a bare 403 that never mentions
 * `allowedOrigins`. That makes a new default undiagnosable: the app worked
 * before the upgrade and the server does not say why it stopped.
 *
 * Deduplicated per distinct origin, because the header is caller-controlled:
 * without that, a hostile client rotating `Origin` values turns a diagnostic
 * into a log-flooding amplifier.
 *
 * The dedup set **evicts oldest rather than refusing to log** once full. A hard
 * cap looks safer and is worse: 32 junk origins after a deploy would silence
 * every later rejection, including the real customer origin an operator needs
 * during an incident — attacker-controlled observability. Eviction keeps memory
 * bounded at 32 entries while leaving the diagnostic live; the resulting log
 * volume is proportional to the distinct-origin rate, which is already the rate
 * at which this caller is being answered 403 anyway.
 *
 * Logs and ALSO returns the message (or `undefined` when already reported), so
 * the dedup contract is testable without depending on `DEBUG` being set.
 */
export function rejectedOriginLogger(
  allowedDescription: string,
): (origin: string | null | undefined) => string | undefined {
  const MAX_TRACKED = 32;
  const seen = new Set<string>();
  return origin => {
    const key = origin ?? '(none)';
    if (seen.has(key)) return undefined;
    if (seen.size >= MAX_TRACKED) {
      // Drop the oldest entry (Set iterates in insertion order) so the tracker
      // stays bounded without ever going permanently blind.
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    seen.add(key);
    const message =
      `rejected MCP request from Origin ${key} — it is not in the allowlist ` +
      `[${allowedDescription}]. Add it to \`allowedOrigins\` (or to ` +
      '`rest.cors`, which the default allowlist is derived from) if this ' +
      'client is legitimate.';
    log.warn(message);
    return message;
  };
}

/**
 * Merge `Mcp-Session-Id` into an `Access-Control-Expose-Headers` value.
 *
 * Under CORS a browser can only READ a response header that is named here, and
 * the session id is the one header the MCP session protocol requires a client
 * to read and echo back. Without it a cross-origin browser client completes
 * `initialize`, cannot see the minted id, sends nothing on the next request,
 * and is answered "no active MCP session" — a failure that looks like a
 * server bug and never mentions CORS. `curl` is unaffected, so this reproduces
 * only in a browser.
 *
 * This is **not** an access grant: whether an origin may read the response at
 * all is decided by `Access-Control-Allow-Origin`, which stays entirely
 * governed by the app's `rest.cors` config. With no `cors` configured there is
 * no allow-origin and this header is inert. So it is safe to always send on the
 * session path, and pointless on the stateless one (no session is ever minted).
 *
 * Any value the app's own CORS config already set is preserved — an app that
 * exposes its own headers must not lose them to this.
 */
export function withSessionIdExposed(existing?: string | null): string {
  const names = (existing ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (names.some(n => n.toLowerCase() === 'mcp-session-id')) {
    return names.join(', ');
  }
  return [...names, 'Mcp-Session-Id'].join(', ');
}

/** Everything the two hosts share when `protocol: 'both'` is enabled. */
export interface StatelessSetup {
  /** Whether stateless serving is on. */
  enabled: boolean;
  /** The handler serving both protocol eras. Present only when enabled. */
  handler?: McpHttpHandler;
  /**
   * DNS-rebinding allowlists, already normalized to the hostnames the SDK's
   * validators compare against. Each host applies these in its own idiom
   * (Express middleware vs fetch `Response` builders), which is the one part
   * that genuinely differs and so is deliberately NOT shared.
   */
  allowedHostnames?: string[];
  /**
   * `Origin` policy, or absent when no check runs. Rules carry their own
   * matching precision — see {@link OriginRule}.
   */
  originRules?: OriginRule[];
}

/**
 * Build the stateless serving setup both hosts need.
 *
 * Extracted because the two mounts previously kept their own copies of this —
 * the same shape that let `SessionBinder` drift and hand one host the wrong
 * request type. Consolidating means an option added here cannot be wired on one
 * host and forgotten on the other.
 */
export function setupStateless(
  mcp: MCPServer,
  options: McpHttpOptions,
): StatelessSetup {
  if (options.protocol === 'legacy') return {enabled: false};

  // `eventStore` is an explicit request for resumable SSE, which is a SESSION
  // feature — the stateless era has no sessions and cannot replay. So an app
  // that configured it and did not name a protocol keeps sessions: the default
  // flip must never silently remove a capability the caller asked for by name.
  // Setting `protocol` explicitly always wins, in either direction.
  if (options.protocol === undefined && options.eventStore) {
    log.info(
      'serving the 2025 era (sessions) because `eventStore` is set — ' +
        'resumable SSE replay needs a session, and the default ' +
        "protocol: 'both' has none. Pass protocol: 'both' explicitly to take " +
        'the 2026-07-28 revision and drop resumability.',
    );
    return {enabled: false};
  }
  if (options.eventStore) {
    log.warn(
      "protocol: 'both' ignores `eventStore` — resumable SSE replay is a " +
        'session feature and the stateless era has no sessions.',
    );
  }
  // Origin validation is a spec MUST, not a hardening option: every Streamable
  // HTTP revision since 2025-03-26 says "Servers MUST validate the `Origin`
  // header on all incoming connections to prevent DNS rebinding attacks". It
  // defaults ON here rather than only when an allowlist is configured, because
  // "browser-reachable with no allowlist" is the exact combination the guard
  // exists to stop — and since 0.9.0 made this the default mount, reaching it
  // by accident got easy.
  //
  // This is safe to default because a MISSING `Origin` passes by design (see
  // `validateOriginHeader`): only browsers send the header, so no MCP client,
  // curl, or stdio bridge is affected. The only request that can newly fail is
  // a browser one — which is the case being defended.
  //
  // The allowlist is derived from `rest.cors` rather than configured twice:
  // those origins are already the app's statement of which browsers may call
  // it. When CORS admits any origin there is nothing to enumerate, so we warn
  // instead of guessing — locking such an app down to localhost would break
  // the browser client its own config allows.
  //
  // Scoped to stateless serving on purpose: the two paths read `allowedOrigins`
  // differently (this one hostname-wise via `toHostnames`, the session
  // transport by exact string match on the raw header), so a derived
  // `localhost` would 403 a browser on `http://localhost:3000` under sessions.
  // The early returns above mean the session path never reaches here.
  const {rules: originRules, warning} = deriveOriginAllowlist(options);
  if (warning) log.warn(warning);
  const rebinding =
    options.enableDnsRebindingProtection ??
    (options.allowedHosts != null || originRules != null);

  return {
    enabled: true,
    handler: createMcpHandler(
      perRequestFactory({
        mcp,
        authEnabled: Boolean(options.auth ?? options.strategyAuth),
        ...(options.perSession ? {binder: options.perSession} : {}),
        ...(options.appContext ? {appContext: options.appContext} : {}),
      }),
      {
        // Without this, a throwing factory — which is where the perSession
        // binder runs — answers 500 with nothing logged, so an entitlement
        // outage presents as an unexplained error from our server.
        onerror: (error: Error) =>
          log.error('stateless request failed: %s', error.stack ?? error),
      },
    ),
    ...(rebinding && options.allowedHosts
      ? {allowedHostnames: toHostnames(options.allowedHosts)}
      : {}),
    ...(rebinding && originRules ? {originRules} : {}),
  };
}
