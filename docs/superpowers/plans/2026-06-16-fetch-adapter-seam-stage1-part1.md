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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
