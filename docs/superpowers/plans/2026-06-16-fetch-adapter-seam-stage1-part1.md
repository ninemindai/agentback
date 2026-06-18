# Fetch Adapter Seam — Stage 1 Part 1 (Neutral Plumbing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the runtime-neutral request/response plumbing for `@agentback/rest` — a core router, Node↔Web converters, a `FetchHost`, and a Node `RequestListener` — as standalone, fully-tested modules that do not touch the existing `RestServer`.

**Architecture:** New `packages/rest/src/web/` (router, convert) and `packages/rest/src/host/` (fetch, node) modules. Everything speaks the Web `Request`/`Response` globals (Node 22, via undici). These are the leaf primitives the later `RestHandler` (Part 2) and Express cutover (Part 3) compose; built first and in isolation so the seam shape and the Node↔Web conversion cost are proven before any server surgery.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node 22 Web globals (`Request`/`Response`/`Headers`/`ReadableStream`), `node:stream` (`Readable.toWeb`/`fromWeb`, `stream/promises` `pipeline`), `node:http`, vitest. No new dependencies.

> **Reference spec:** `docs/superpowers/specs/2026-06-16-fetch-adapter-seam-design.md`. This plan implements the foundation of its "Stage 1 · Core seam" row and the `router.ts` / `convert.ts` / `host/fetch.ts` / `host/node.ts` component rows. The dispatch logic (`rest-handler.ts`), the Express demotion/cutover, the middleware onion, and uploads are **out of scope here** and covered by follow-up plans.

> **Critical build rule (from CLAUDE.md):** vitest runs against built `dist/`, NOT `src/`. Every "run the test" step below builds first with `pnpm -F @agentback/rest build`, then runs vitest against the compiled `.js`. Do not skip the build.

> **License header:** match the existing `packages/rest/src/rest.server.ts` 3-line header exactly (shown in each Create step).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/rest/src/web/router.ts` | `Router<T>`: register `{method, template, value}` routes; `match(method, pathname)` → `{value, params}` or `undefined`. Non-greedy. Pure, no I/O. |
| `packages/rest/src/web/convert.ts` | `toWebRequest(IncomingMessage): Request` and `writeWebResponse(ServerResponse, Response): Promise<void>`. The only Node↔Web boundary. |
| `packages/rest/src/host/fetch.ts` | `createFetchHost<T>({router, dispatch, notFound?})`: composes a router + a dispatch fn into a `{fetch(req): Promise<Response>}`. The `FetchHostAdapter`. |
| `packages/rest/src/host/node.ts` | `createNodeListener(host): RequestListener`: converts Node req → Web, calls `host.fetch`, writes the Web response back. |
| `packages/rest/src/__tests__/unit/web-router.unit.ts` | Router tests. |
| `packages/rest/src/__tests__/unit/web-convert.unit.ts` | `toWebRequest` tests. |
| `packages/rest/src/__tests__/unit/host-fetch.unit.ts` | `createFetchHost` tests. |
| `packages/rest/src/__tests__/integration/host-node.integration.ts` | End-to-end Node round-trip (exercises convert both ways + fetch host). |
| `packages/rest/src/index.ts` | Add exports for the new public symbols. |

---

## Task 1: Core Router

**Files:**
- Create: `packages/rest/src/web/router.ts`
- Test: `packages/rest/src/__tests__/unit/web-router.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/rest/src/__tests__/unit/web-router.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Router} from '../../web/router.js';

describe('Router', () => {
  it('matches a literal path', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/health', value: 'h'});
    const m = r.match('GET', '/health');
    expect(m).toEqual({value: 'h', params: {}});
  });

  it('extracts and URL-decodes path params', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/greet/hello/{name}', value: 'g'});
    const m = r.match('GET', '/greet/hello/Ada%20Lovelace');
    expect(m).toEqual({value: 'g', params: {name: 'Ada Lovelace'}});
  });

  it('matches multiple params', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/a/{x}/b/{y}', value: 'v'});
    expect(r.match('GET', '/a/1/b/2')).toEqual({
      value: 'v',
      params: {x: '1', y: '2'},
    });
  });

  it('is method-sensitive but case-insensitive on the verb', () => {
    const r = new Router<string>();
    r.add({method: 'POST', template: '/echo', value: 'e'});
    expect(r.match('post', '/echo')).toEqual({value: 'e', params: {}});
    expect(r.match('GET', '/echo')).toBeUndefined();
  });

  it('returns undefined when nothing matches (non-greedy)', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/health', value: 'h'});
    expect(r.match('GET', '/nope')).toBeUndefined();
  });

  it('does not match on segment-count mismatch', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/a/{x}', value: 'v'});
    expect(r.match('GET', '/a/1/2')).toBeUndefined();
    expect(r.match('GET', '/a')).toBeUndefined();
  });

  it('normalizes trailing slashes', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/health', value: 'h'});
    expect(r.match('GET', '/health/')).toEqual({value: 'h', params: {}});
  });

  it('returns the first registered match', () => {
    const r = new Router<string>();
    r.add({method: 'GET', template: '/x/{a}', value: 'first'});
    r.add({method: 'GET', template: '/x/{b}', value: 'second'});
    expect(r.match('GET', '/x/1')?.value).toBe('first');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/rest build
```
Expected: build FAILS — `Cannot find module '../../web/router.js'` (the source file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/rest/src/web/router.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Runtime-neutral route matcher. Owns the routing that Express used to do, so
 * the same dispatch runs on any host (Node, Fetch). Non-greedy: an unmatched
 * request returns `undefined`, letting the host fall through to other mounts.
 */
export interface RouteRecord<T> {
  /** HTTP method; compared case-insensitively. */
  method: string;
  /** Path template with `{name}` placeholders, e.g. `/greet/hello/{name}`. */
  template: string;
  /** Opaque payload returned on match (later: the route's schemas/handler). */
  value: T;
}

export interface RouteMatch<T> {
  value: T;
  params: Record<string, string>;
}

interface CompiledRoute<T> {
  method: string;
  segments: string[];
  value: T;
}

function splitPath(p: string): string[] {
  // Drop leading/trailing slashes, then split. '/' and '' both yield [].
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/');
}

export class Router<T> {
  private readonly routes: CompiledRoute<T>[] = [];

  add(record: RouteRecord<T>): void {
    this.routes.push({
      method: record.method.toUpperCase(),
      segments: splitPath(record.template),
      value: record.value,
    });
  }

  match(method: string, pathname: string): RouteMatch<T> | undefined {
    const verb = method.toUpperCase();
    const segs = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== verb) continue;
      if (route.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const tmpl = route.segments[i]!;
        const actual = segs[i]!;
        if (tmpl.startsWith('{') && tmpl.endsWith('}')) {
          params[tmpl.slice(1, -1)] = decodeURIComponent(actual);
        } else if (tmpl !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return {value: route.value, params};
    }
    return undefined;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F @agentback/rest build
pnpm exec vitest run packages/rest/dist/__tests__/unit/web-router.unit.js
```
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/rest/src/web/router.ts packages/rest/src/__tests__/unit/web-router.unit.ts
git commit -m "feat(rest): runtime-neutral core Router"
```

---

## Task 2: Node → Web Request converter

**Files:**
- Create: `packages/rest/src/web/convert.ts`
- Test: `packages/rest/src/__tests__/unit/web-convert.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/rest/src/__tests__/unit/web-convert.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import {toWebRequest} from '../../web/convert.js';

/** Build a minimal IncomingMessage-like object from a body string. */
function fakeReq(opts: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from(
    opts.body == null ? [] : [Buffer.from(opts.body)],
  ) as unknown as IncomingMessage;
  stream.method = opts.method;
  stream.url = opts.url;
  stream.headers = opts.headers;
  return stream;
}

describe('toWebRequest', () => {
  it('maps method, URL (from host header), and headers', () => {
    const req = fakeReq({
      method: 'GET',
      url: '/greet/hello/Ada?loud=1',
      headers: {host: 'example.test', 'x-trace': 'abc'},
    });
    const web = toWebRequest(req);
    expect(web.method).toBe('GET');
    expect(new URL(web.url).pathname).toBe('/greet/hello/Ada');
    expect(new URL(web.url).searchParams.get('loud')).toBe('1');
    expect(web.headers.get('x-trace')).toBe('abc');
  });

  it('streams a POST body through to .text()', async () => {
    const req = fakeReq({
      method: 'POST',
      url: '/echo',
      headers: {host: 'x', 'content-type': 'application/json'},
      body: '{"text":"hi"}',
    });
    const web = toWebRequest(req);
    expect(await web.text()).toBe('{"text":"hi"}');
  });

  it('omits the body for GET', () => {
    const req = fakeReq({method: 'GET', url: '/x', headers: {host: 'x'}});
    const web = toWebRequest(req);
    expect(web.body).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/rest build
```
Expected: build FAILS — `Cannot find module '../../web/convert.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/rest/src/web/convert.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage, ServerResponse} from 'node:http';

/**
 * The single Node↔Web boundary. The runtime-neutral core speaks Web
 * `Request`/`Response`; these adapt Node's `http` objects so Express (and any
 * other Node host) can drive it. Uses Node 22's global Web classes — no deps.
 */

// `duplex` is required by undici for streaming request bodies but is missing
// from some `RequestInit` lib typings.
type StreamingRequestInit = RequestInit & {duplex?: 'half'};

export function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;
  const method = (req.method ?? 'GET').toUpperCase();

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value != null) headers.set(key, value);
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: StreamingRequestInit = {method, headers};
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export async function writeWebResponse(
  res: ServerResponse,
  web: Response,
): Promise<void> {
  res.statusCode = web.status;
  web.headers.forEach((value, key) => res.setHeader(key, value));
  if (!web.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(web.body as never), res);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F @agentback/rest build
pnpm exec vitest run packages/rest/dist/__tests__/unit/web-convert.unit.js
```
Expected: PASS — 3 tests pass. (`writeWebResponse` is covered end-to-end in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add packages/rest/src/web/convert.ts packages/rest/src/__tests__/unit/web-convert.unit.ts
git commit -m "feat(rest): Node<->Web request/response converters"
```

---

## Task 3: Fetch host

**Files:**
- Create: `packages/rest/src/host/fetch.ts`
- Test: `packages/rest/src/__tests__/unit/host-fetch.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/rest/src/__tests__/unit/host-fetch.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Router} from '../../web/router.js';
import {createFetchHost} from '../../host/fetch.js';

describe('createFetchHost', () => {
  it('routes a matched request to dispatch with params', async () => {
    const router = new Router<string>();
    router.add({method: 'GET', template: '/greet/{name}', value: 'greet'});
    const host = createFetchHost({
      router,
      dispatch: async (match) =>
        Response.json({value: match.value, params: match.params}),
    });
    const res = await host.fetch(
      new Request('http://x/greet/Ada', {method: 'GET'}),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({value: 'greet', params: {name: 'Ada'}});
  });

  it('returns a 404 JSON envelope when nothing matches', async () => {
    const host = createFetchHost({
      router: new Router<string>(),
      dispatch: async () => Response.json({}),
    });
    const res = await host.fetch(new Request('http://x/missing'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {code: 'not_found', message: 'Not Found'},
    });
  });

  it('honors a custom notFound handler', async () => {
    const host = createFetchHost({
      router: new Router<string>(),
      dispatch: async () => Response.json({}),
      notFound: () => new Response('nope', {status: 418}),
    });
    const res = await host.fetch(new Request('http://x/missing'));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('nope');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/rest build
```
Expected: build FAILS — `Cannot find module '../../host/fetch.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/rest/src/host/fetch.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Router, RouteMatch} from '../web/router.js';

/** A runtime-neutral request handler: the unit every host adapter wraps. */
export interface FetchHost {
  fetch(req: Request): Promise<Response>;
}

export interface FetchHostOptions<T> {
  router: Router<T>;
  /** Called with the matched route + the incoming request; returns the body. */
  dispatch: (match: RouteMatch<T>, req: Request) => Promise<Response>;
  /** Produced when the router has no match. Defaults to a 404 JSON envelope. */
  notFound?: (req: Request) => Response | Promise<Response>;
}

function defaultNotFound(): Response {
  return Response.json(
    {error: {code: 'not_found', message: 'Not Found'}},
    {status: 404},
  );
}

/**
 * Compose a {@link Router} and a dispatch function into a {@link FetchHost}.
 * This is the FetchHostAdapter: on Workers/Deno/Bun you export `host.fetch`;
 * in tests you call it directly with a `Request` and assert the `Response`.
 */
export function createFetchHost<T>(opts: FetchHostOptions<T>): FetchHost {
  const notFound = opts.notFound ?? defaultNotFound;
  return {
    async fetch(req: Request): Promise<Response> {
      const {pathname} = new URL(req.url);
      const match = opts.router.match(req.method, pathname);
      if (!match) return notFound(req);
      return opts.dispatch(match, req);
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F @agentback/rest build
pnpm exec vitest run packages/rest/dist/__tests__/unit/host-fetch.unit.js
```
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/rest/src/host/fetch.ts packages/rest/src/__tests__/unit/host-fetch.unit.ts
git commit -m "feat(rest): FetchHost adapter composing router + dispatch"
```

---

## Task 4: Node listener + end-to-end round-trip

**Files:**
- Create: `packages/rest/src/host/node.ts`
- Test: `packages/rest/src/__tests__/integration/host-node.integration.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/rest/src/__tests__/integration/host-node.integration.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import http from 'node:http';
import {AddressInfo} from 'node:net';
import {Router} from '../../web/router.js';
import {createFetchHost} from '../../host/fetch.js';
import {createNodeListener} from '../../host/node.js';

// A walking skeleton: Router -> FetchHost -> Node listener, served over a real
// socket and driven with the global fetch. Exercises BOTH conversion
// directions (Node req -> Web Request, Web Response -> Node res).
const router = new Router<string>();
router.add({method: 'GET', template: '/greet/{name}', value: 'greet'});
router.add({method: 'POST', template: '/echo', value: 'echo'});

const host = createFetchHost({
  router,
  dispatch: async (match, req) => {
    if (match.value === 'echo') {
      const body = (await req.json()) as {text: string};
      return Response.json({echoed: body.text}, {status: 201});
    }
    return Response.json({greeting: `Hello, ${match.params.name}!`});
  },
});

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(createNodeListener(host));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const {port} = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('createNodeListener (end-to-end)', () => {
  it('round-trips a GET with a path param', async () => {
    const res = await fetch(`${base}/greet/Ada`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({greeting: 'Hello, Ada!'});
  });

  it('round-trips a POST body and a non-200 status', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: 'hi'}),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({echoed: 'hi'});
  });

  it('returns the default 404 envelope for unmatched paths', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {code: 'not_found', message: 'Not Found'},
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/rest build
```
Expected: build FAILS — `Cannot find module '../../host/node.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/rest/src/host/node.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RequestListener} from 'node:http';
import {loggers} from '@agentback/common';
import {toWebRequest, writeWebResponse} from '../web/convert.js';
import type {FetchHost} from './fetch.js';

const log = loggers('agentback:rest:host:node');

/**
 * Adapt a {@link FetchHost} to a Node `http` `RequestListener`. Used directly
 * with `http.createServer`, and (in a later plan) mounted as the non-greedy
 * fallback inside the Express NodeHostAdapter.
 */
export function createNodeListener(host: FetchHost): RequestListener {
  return (req, res) => {
    void (async () => {
      try {
        const webRes = await host.fetch(toWebRequest(req));
        await writeWebResponse(res, webRes);
      } catch (err) {
        log.error('node listener failed: %s', (err as Error).message);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
        }
        res.end(
          JSON.stringify({
            error: {code: 'internal_error', message: 'Internal Server Error'},
          }),
        );
      }
    })();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F @agentback/rest build
pnpm exec vitest run packages/rest/dist/__tests__/integration/host-node.integration.js
```
Expected: PASS — 3 tests pass. This confirms `toWebRequest`, `writeWebResponse`, `Router`, and `createFetchHost` all work together over a real socket.

- [ ] **Step 5: Commit**

```bash
git add packages/rest/src/host/node.ts packages/rest/src/__tests__/integration/host-node.integration.ts
git commit -m "feat(rest): Node RequestListener adapter + e2e round-trip"
```

---

## Task 5: Public exports + full-package regression check

**Files:**
- Modify: `packages/rest/src/index.ts`

- [ ] **Step 1: Confirm the export style**

```bash
grep -n "export" packages/rest/src/index.ts | head -40
```
Expected: the file uses barrel `export * from './….js';` lines. Match that style.

- [ ] **Step 2: Add the new exports**

Append to `packages/rest/src/index.ts`, matching the existing `export *` barrel style:

```ts
export * from './web/router.js';
export * from './web/convert.js';
export * from './host/fetch.js';
export * from './host/node.js';
```

- [ ] **Step 3: Build and run the full rest package test suite (regression guard)**

```bash
pnpm -F @agentback/rest build
pnpm exec vitest run packages/rest/dist
```
Expected: PASS — all existing `@agentback/rest` tests still pass, plus the new web/host tests. No existing test changed (these modules are additive and untouched by `RestServer`).

- [ ] **Step 4: Lint**

```bash
pnpm lint
```
Expected: no errors for the new files. Fix any prettier/eslint issues (single quotes, no bracket spacing, trailing commas) and re-run.

- [ ] **Step 5: Commit**

```bash
git add packages/rest/src/index.ts
git commit -m "feat(rest): export web/host neutral plumbing"
```

---

## Out of scope (covered by follow-up plans)

- **Stage 1 Part 2 — `RestHandler` dispatch:** retarget the existing `dispatch`/`invokeRoute`/`sendResult`/`sendError`/`sendStream` pipeline to consume a Web `Request` + `RouteMatch` and return a Web `Response` (auth, authz, Zod input/output validation, dispatch hooks, confirmation/idempotency, error envelope). This is the dispatch fn that `createFetchHost` receives. Includes the **Node↔Web conversion benchmark** gate from the spec.
- **Stage 1 Part 3 — Express demotion/cutover:** wire the route registry into the `Router`, mount `createNodeListener(host)` as the non-greedy Express fallback inside a slimmed `RestServer` (preserving `start`/`stop`/`url`/`expressApp`), and add the `createTestApp` in-process `fetch` client + the Node/Fetch parity test harness.
- **Stage 2 — middleware onion.** **Stage 3 — multipart uploads + streaming downloads.**
- **Documented follow-ups:** neutralize `install*` UI mounts; `FastifyHostAdapter`; real edge deploy + RegExpRouter.

---

## Self-Review

**Spec coverage (this plan's slice):**
- Spec component `router.ts` → Task 1 ✅
- Spec component `convert.ts` → Task 2 ✅
- Spec component `host/fetch.ts` (FetchHostAdapter) → Task 3 ✅
- Spec component `host/node.ts` → Task 4 ✅
- Spec "no deployment; the Fetch handler tests are the proof" → Tasks 3–4 drive the handler directly/over a socket ✅
- Spec rows `rest-handler.ts`, Express cutover, middleware, uploads → explicitly deferred to follow-up plans (listed) ✅

**Placeholder scan:** No TBD/TODO; every code step contains complete, runnable code; every run step has an exact command + expected result.

**Type consistency:** `Router<T>` / `RouteRecord<T>` / `RouteMatch<T>` defined in Task 1 and consumed unchanged in Tasks 3–4. `FetchHost` / `FetchHostOptions<T>` / `createFetchHost` defined in Task 3, consumed in Task 4. `toWebRequest` / `writeWebResponse` defined in Task 2, consumed in Task 4. The 404 envelope shape `{error:{code:'not_found',message:'Not Found'}}` is identical in Task 3's impl and Task 4's assertion. The `value` payloads are `string` throughout the tests (the generic is exercised concretely).

**Build rule:** every test step builds the package before running vitest against `dist/` — consistent with CLAUDE.md.

---

## Eng-Review Revisions (plan-eng-review, 2026-06-16)

These seven decisions SUPERSEDE the tasks above where they conflict. Apply them when executing.

### D1 — Adopt `@hono/node-server` for Node↔Web conversion (replaces `convert.ts`)

`convert.ts` was protocol-compatibility code mis-scoped as a utility, and as written corrupted multiple `Set-Cookie` headers (`Headers.forEach` coalesces them). Use the battle-tested library instead.

- **DELETE Task 2 entirely** (`web/convert.ts` + `web-convert.unit.ts` are not created).
- **Add dependency:** `pnpm -F @agentback/rest add @hono/node-server` (Node-host-only; the Fetch host needs no conversion).
- **Task 4 `host/node.ts` becomes a thin wrapper** over Hono's listener — which handles Set-Cookie multiplicity, `AbortSignal`/client-disconnect, HEAD, 204, Content-Length, and stream errors for free:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {getRequestListener} from '@hono/node-server';
import type {RequestListener} from 'node:http';
import type {FetchHost} from './fetch.js';

/**
 * Adapt a {@link FetchHost} to a Node `http` `RequestListener` via
 * `@hono/node-server`, which owns the Node↔Web conversion (Set-Cookie
 * multiplicity, client-abort wiring, HEAD/204/Content-Length, stream errors).
 * Part 3 mounts the underlying `router.match` as the non-greedy Express
 * fallback; `FetchHost.fetch` itself is terminal (always responds) — correct
 * for the Workers/Fetch host.
 */
export function createNodeListener(host: FetchHost): RequestListener {
  return getRequestListener(req => host.fetch(req));
}
```

- **URL/trust-proxy policy (Codex):** scheme/host reconstruction and `X-Forwarded-*` handling are now owned by `@hono/node-server` (Node host) and Express's `trust proxy` in Part 3. State in Part 3's plan that trust-proxy is an Express-config policy; do not reconstruct URLs by hand.

### D2 — Pin the `Dispatch` contract (keep the staged split)

Before Task 3, add `web/dispatch.ts` declaring the type Part 2's `RestHandler` will implement, so `FetchHost` is validated against the real consumer's needs on paper:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RouteMatch} from './router.js';

/**
 * The contract Part 2's RestHandler implements. Pinned here so Part 1's
 * FetchHost interface is consumer-validated before RestHandler exists.
 * `T` carries whatever the router stores per route (Part 2: the route's Zod
 * schemas + controller ref); the per-request DI Context is derived inside the
 * dispatch impl from the request, not threaded here.
 */
export type Dispatch<T> = (match: RouteMatch<T>, req: Request) => Promise<Response>;
```

`FetchHostOptions<T>.dispatch` is typed as `Dispatch<T>`.

### D3 — Flat 404 envelope

`defaultNotFound` must match the system-wide `ErrorEnvelope` (flat `{code, message}`, openapi/src/agent-error.ts:19), NOT a nested `{error:{…}}`:

```ts
function defaultNotFound(): Response {
  return Response.json({code: 'not_found', message: 'Not Found'}, {status: 404});
}
```

Update Task 3's two assertions accordingly (`expect(await res.json()).toEqual({code: 'not_found', message: 'Not Found'})`). FetchHost stays generic (no `@agentback/openapi` import); Part 2 overrides `notFound` with `buildErrorEnvelope`.

### D4 — e2e edge coverage (Task 4)

Add to `host-node.integration.ts`, beyond the three happy-path tests:

- **[REGRESSION — mandatory]** two `Set-Cookie` headers survive intact:
```ts
it('preserves multiple Set-Cookie headers (D1 regression)', async () => {
  router.add({method: 'GET', template: '/multi', value: 'multi'});
  // dispatch for 'multi' returns:
  //   new Response(null, {status: 204, headers: new Headers([
  //     ['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2; Path=/']])})
  const res = await fetch(`${base}/multi`);
  expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
});
```
- **HEAD** request → status + headers, empty body (`await res.text()` is `''`).
- **Streaming** `ReadableStream` response body → chunks arrive intact (dispatch returns `new Response(stream)`; assert the concatenated text).

(Add the `/multi` + streaming routes to the test's router/dispatch setup.)

### D5 — Keep Part 1 internal until Part 3 (DELETE Task 5's exports)

Do **not** add the modules to `packages/rest/src/index.ts`. The `web/` + `host/` modules stay package-internal until Part 3 proves `RestHandler` parity, then the validated surface is exported in one commit. Task 5 keeps only its regression-guard + lint steps:

- Step 2 (the `export * from` additions) is **removed**.
- Steps 3–5 (build, full `@agentback/rest` suite green, lint, commit) stay — commit message becomes `test(rest): neutral plumbing internal (router + fetch/node hosts)`.

### D6 — Router decode safety (Task 1)

`decodeURIComponent` throws on malformed input (`%ZZ`). `match()` must be total: catch and treat as a non-match.

### D7 — Router specificity ranking + duplicate rejection (Task 1, REWRITES it)

Replace Task 1's implementation and tests with the version below. Static segments beat params regardless of registration order; structurally-identical routes (same method + same segment pattern modulo param names) throw at registration.

**`web/router.ts`:**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export interface RouteRecord<T> {
  method: string;
  /** Path template with `{name}` placeholders, e.g. `/greet/hello/{name}`. */
  template: string;
  value: T;
}

export interface RouteMatch<T> {
  value: T;
  params: Record<string, string>;
}

interface CompiledRoute<T> {
  method: string;
  segments: string[];
  value: T;
}

const isParam = (seg: string): boolean => seg.startsWith('{') && seg.endsWith('}');

function splitPath(p: string): string[] {
  const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/');
}

/** Structural key: params normalized to `{}` so name differences collide. */
function structuralKey(method: string, segments: string[]): string {
  return method + ' ' + segments.map(s => (isParam(s) ? '{}' : s)).join('/');
}

export class Router<T> {
  private readonly routes: CompiledRoute<T>[] = [];
  private readonly seen = new Set<string>();

  add(record: RouteRecord<T>): void {
    const method = record.method.toUpperCase();
    const segments = splitPath(record.template);
    const key = structuralKey(method, segments);
    if (this.seen.has(key)) {
      throw new Error(
        `Router: duplicate route ${record.method} ${record.template} ` +
          `(a structurally identical route is already registered)`,
      );
    }
    this.seen.add(key);
    this.routes.push({method, segments, value: record.value});
    // Specificity order: at the first segment where two routes differ in kind,
    // a literal is more specific than a param. Stable sort keeps registration
    // order for equally-specific routes. So /users/me beats /users/{id}
    // regardless of who was added first.
    this.routes.sort((a, b) => {
      const n = Math.min(a.segments.length, b.segments.length);
      for (let i = 0; i < n; i++) {
        const ap = isParam(a.segments[i]!);
        const bp = isParam(b.segments[i]!);
        if (ap !== bp) return ap ? 1 : -1; // literal (false) sorts first
      }
      return 0;
    });
  }

  match(method: string, pathname: string): RouteMatch<T> | undefined {
    const verb = method.toUpperCase();
    const segs = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== verb) continue;
      if (route.segments.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const tmpl = route.segments[i]!;
        const actual = segs[i]!;
        if (isParam(tmpl)) {
          try {
            params[tmpl.slice(1, -1)] = decodeURIComponent(actual);
          } catch {
            ok = false; // malformed %-encoding → non-match (D6)
            break;
          }
        } else if (tmpl !== actual) {
          ok = false;
          break;
        }
      }
      if (ok) return {value: route.value, params};
    }
    return undefined;
  }
}
```

**`web-router.unit.ts`** — keep the literal / param-decode / multi-param / method-case / no-match / segment-count / trailing-slash tests; **replace** the old "returns the first registered match" test (now an illegal structural duplicate) with these three:

```ts
it('rejects a structurally duplicate route at registration', () => {
  const r = new Router<string>();
  r.add({method: 'GET', template: '/x/{a}', value: 'first'});
  expect(() => r.add({method: 'GET', template: '/x/{b}', value: 'second'})).toThrow(
    /duplicate route/,
  );
});

it('prefers a static segment over a param regardless of order', () => {
  const r = new Router<string>();
  r.add({method: 'GET', template: '/users/{id}', value: 'param'});
  r.add({method: 'GET', template: '/users/me', value: 'static'});
  expect(r.match('GET', '/users/me')?.value).toBe('static');
  expect(r.match('GET', '/users/42')?.value).toBe('param');
});

it('treats malformed percent-encoding as a non-match (never throws)', () => {
  const r = new Router<string>();
  r.add({method: 'GET', template: '/greet/{name}', value: 'g'});
  expect(r.match('GET', '/greet/%ZZ')).toBeUndefined();
});
```

---

## NOT in scope (deferred, with rationale)

- **`RestHandler` dispatch (auth/validation/DI/error envelope)** — Part 2; the `Dispatch<T>` contract is pinned here (D2) but not implemented.
- **Express demotion / non-greedy fallback / `createTestApp` fetch client / parity harness** — Part 3; `FetchHost.fetch` is terminal by design, the Express fallback wraps `router.match` directly.
- **Middleware onion** — Stage 2. **Multipart uploads + streaming downloads** — Stage 3.
- **Public exports of the new modules** — deferred to Part 3 (D5).
- **RegExpRouter** — the deferred matcher optimization; the D7 ranking is the interim correct-but-linear version.
- **Full request-header `rawHeaders` fidelity, trailers, 1xx** — owned by `@hono/node-server`; not separately exercised.
- **`FastifyHostAdapter`, real Workers/Deno deploy, neutralizing `install*` UI mounts** — spec-level follow-ups.

## What already exists (reuse vs rebuild)

- `@agentback/http-server` (`http.createServer` wrapper) — complemented, not duplicated; Part 3's Express host uses it.
- `@agentback/openapi` `buildErrorEnvelope` / `ErrorCodes.NOT_FOUND` — Part 2's dispatch reuses these for the real envelope; Part 1's generic default only mirrors the flat *shape* (D3).
- `@hono/node-server` — **adopted** (D1) instead of rebuilding Node↔Web conversion.
- Express routing — intentionally replaced by the core `Router` (the Fetch host has no Express router).

## Failure modes (per new codepath)

| Codepath | Realistic failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| `Router.match` | malformed `%`-encoding throws | ✅ D6 test | ✅ caught → non-match | clean 404 |
| `Router.add` | duplicate/shadowing route | ✅ D7 test | ✅ throws at `add()` (startup) | startup error, not prod misroute |
| `host/node` (Hono) | multiple `Set-Cookie` corrupted | ✅ D4 regression | ✅ library `getSetCookie` | both cookies set |
| `host/node` (Hono) | client disconnect mid-stream | ⚠️ not unit-tested | ✅ library wires `AbortSignal` | stream aborted, no leak |
| `FetchHost.fetch` | unmatched path | ✅ Task 3 | ✅ flat 404 (D3) | `{code:'not_found'}` |

No critical gaps (no failure mode is simultaneously untested, unhandled, and silent).

## Worktree parallelization

Sequential — all tasks touch `packages/rest/src/{web,host}/` and depend on the prior (Router → Dispatch type → FetchHost → Node host → guard). No parallelization opportunity.

## Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding above.

- [ ] **T1 (P1, human: ~2h / CC: ~20min)** — host/node — Adopt `@hono/node-server`; delete `convert.ts`/its test; rewrite `createNodeListener` as a `getRequestListener` wrapper.
  - Surfaced by: Architecture D1 + Codex (Set-Cookie corruption, abort, header multiplicity)
  - Files: `packages/rest/package.json`, `packages/rest/src/host/node.ts`; delete `packages/rest/src/web/convert.ts`
  - Verify: `pnpm -F @agentback/rest build && pnpm exec vitest run packages/rest/dist/__tests__/integration/host-node.integration.js`
- [ ] **T2 (P1, human: ~45min / CC: ~10min)** — host/node — Add e2e edge tests: multi-`Set-Cookie` regression (mandatory), HEAD, streaming body.
  - Surfaced by: Test review D4 + REGRESSION RULE
  - Files: `packages/rest/src/__tests__/integration/host-node.integration.ts`
  - Verify: the three new `it(...)` cases pass
- [ ] **T3 (P1, human: ~half day / CC: ~30min)** — web/router — Specificity ranking (static > param) + structural-duplicate throw + decode-safety; update tests.
  - Surfaced by: Architecture/Code-quality D6 + D7 + Codex (router too primitive, decode throws)
  - Files: `packages/rest/src/web/router.ts`, `packages/rest/src/__tests__/unit/web-router.unit.ts`
  - Verify: `pnpm exec vitest run packages/rest/dist/__tests__/unit/web-router.unit.js`
- [ ] **T4 (P2, human: ~20min / CC: ~5min)** — web/dispatch — Pin the `Dispatch<T>` contract; type `FetchHostOptions.dispatch` as it; flat-`{code,message}` 404 default.
  - Surfaced by: Architecture D2 + Code-quality D3
  - Files: `packages/rest/src/web/dispatch.ts`, `packages/rest/src/host/fetch.ts`, `host-fetch.unit.ts`
  - Verify: `pnpm exec vitest run packages/rest/dist/__tests__/unit/host-fetch.unit.js`
- [ ] **T5 (P2, human: ~5min / CC: ~2min)** — rest/index — Do NOT export the new modules; keep internal until Part 3.
  - Surfaced by: Architecture D5 + Codex (premature public API)
  - Files: `packages/rest/src/index.ts` (no change)
  - Verify: `pnpm -F @agentback/rest build && pnpm exec vitest run packages/rest/dist`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | outside-voice: 14 points; 7 folded, rest resolved-by-D1/deferred |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found | 7 findings, 0 critical gaps — all resolved into the plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** flagged convert.ts as protocol code (Set-Cookie corruption, aborts, header fidelity), router primitiveness (shadowing, decode-throw), and premature public export. High overlap with the structured review.

**CROSS-MODEL:** Claude review and Codex agreed on the three load-bearing issues (adopt a conversion library, router needs hardening, don't export prematurely). Codex pushed harder on "keep internal until parity" → resolved as D5. No unresolved tension.

**VERDICT:** ENG CLEARED — 7 findings all folded into the plan, 0 critical gaps. Ready to implement Part 1 with revisions D1–D7.

NO UNRESOLVED DECISIONS
