// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {ClientError, createClient, defineRoute} from '../../index.js';

const HelloPath = z.object({name: z.string().min(1)});
const Greeting = z.object({greeting: z.string()});
const EchoIn = z.object({text: z.string()});
const EchoOut = z.object({echoed: z.string()});
const FilterQuery = z.object({
  limit: z.coerce.number().int(),
  tag: z.array(z.string()).optional(),
});
const TraceHeaders = z.object({'x-trace': z.string()});

/** Build a fake fetch that records calls and returns a canned response. */
function fakeFetch(
  status: number,
  body: unknown,
): {fetch: typeof globalThis.fetch; calls: Array<[string, RequestInit]>} {
  const calls: Array<[string, RequestInit]> = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push([String(input), init ?? {}]);
    return new Response(JSON.stringify(body), {
      status,
      headers: {'content-type': 'application/json'},
    });
  });
  return {fetch: fetch as unknown as typeof globalThis.fetch, calls};
}

describe('defineRoute', () => {
  it('GET with path params: substitutes URL and parses typed response', async () => {
    const hello = defineRoute('GET', '/greet/hello/{name}', {
      path: HelloPath,
      response: Greeting,
    });
    const {fetch, calls} = fakeFetch(200, {greeting: 'Hello, Alice!'});
    const client = createClient({baseURL: 'http://api.test', fetch});

    const out = await hello.call(client, {path: {name: 'Alice'}});

    expect(out).toEqual({greeting: 'Hello, Alice!'});
    expect(calls[0]?.[0]).toBe('http://api.test/greet/hello/Alice');
    expect(calls[0]?.[1].method).toBe('GET');
    expect(calls[0]?.[1].body).toBeUndefined();
  });

  it('POST with body: validates input, JSON-serializes, sets content-type', async () => {
    const echo = defineRoute('POST', '/echo', {
      body: EchoIn,
      response: EchoOut,
    });
    const {fetch, calls} = fakeFetch(200, {echoed: 'ping'});
    const client = createClient({baseURL: 'http://api.test', fetch});

    const out = await echo.call(client, {body: {text: 'ping'}});

    expect(out).toEqual({echoed: 'ping'});
    expect(calls[0]?.[1].body).toBe('{"text":"ping"}');
    const headers = (calls[0]?.[1].headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
  });

  it('query params: serializes arrays + omits undefined', async () => {
    const list = defineRoute('GET', '/list', {query: FilterQuery});
    const {fetch, calls} = fakeFetch(200, []);
    const client = createClient({baseURL: 'http://api.test', fetch});

    await list.call(client, {query: {limit: 5, tag: ['a', 'b']}});

    expect(calls[0]?.[0]).toBe('http://api.test/list?limit=5&tag=a&tag=b');
  });

  it('headers schema: keys are lowercase to match server validation contract', async () => {
    const traced = defineRoute('GET', '/t', {headers: TraceHeaders});
    const {fetch, calls} = fakeFetch(200, {});
    const client = createClient({baseURL: 'http://api.test', fetch});

    // Schema uses lowercase keys (server lowercases incoming headers
    // before validation). The TS type pins the user to that contract.
    await traced.call(client, {headers: {'x-trace': 'abc'}});

    const headers = (calls[0]?.[1].headers ?? {}) as Record<string, string>;
    expect(headers['x-trace']).toBe('abc');
  });

  it('merges defaults < schema < per-call header overrides', async () => {
    const tok = defineRoute('GET', '/me', {});
    const {fetch, calls} = fakeFetch(200, {});
    const client = createClient({
      baseURL: 'http://api.test',
      fetch,
      headers: () => ({authorization: 'Bearer base'}),
    });

    await tok.call(client, undefined, {
      headers: {authorization: 'Bearer call'},
    });

    const headers = (calls[0]?.[1].headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer call');
  });

  it('rejects bad input before any network call', async () => {
    const hello = defineRoute('GET', '/hello/{name}', {
      path: HelloPath,
      response: Greeting,
    });
    const {fetch} = fakeFetch(200, {});
    const client = createClient({baseURL: 'http://api.test', fetch});

    await expect(hello.call(client, {path: {name: ''}})).rejects.toMatchObject({
      status: 0,
      name: 'ClientError',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps non-2xx into a ClientError carrying the error body', async () => {
    const hello = defineRoute('GET', '/hello/{name}', {
      path: HelloPath,
      response: Greeting,
    });
    const {fetch} = fakeFetch(404, {
      error: {statusCode: 404, message: 'Not found'},
    });
    const client = createClient({baseURL: 'http://api.test', fetch});

    const err = await hello.call(client, {path: {name: 'ghost'}}).catch(e => e);
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(404);
    expect((err as ClientError).message).toBe('Not found');
  });

  it('flags responses that fail the response schema', async () => {
    const hello = defineRoute('GET', '/hello/{name}', {
      path: HelloPath,
      response: Greeting,
    });
    // Server returns wrong shape.
    const {fetch} = fakeFetch(200, {unexpected: true});
    const client = createClient({baseURL: 'http://api.test', fetch});

    const err = await hello.call(client, {path: {name: 'x'}}).catch(e => e);
    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).status).toBe(200);
    expect((err as ClientError).message).toMatch(/Response failed validation/);
  });

  describe('safeCall', () => {
    it('returns {success: true, data} on success', async () => {
      const hello = defineRoute('GET', '/hello/{name}', {
        path: HelloPath,
        response: Greeting,
      });
      const {fetch} = fakeFetch(200, {greeting: 'Hi!'});
      const client = createClient({baseURL: 'http://api.test', fetch});

      const result = await hello.safeCall(client, {path: {name: 'x'}});

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual({greeting: 'Hi!'});
    });

    it('returns {success: false, error} on non-2xx', async () => {
      const hello = defineRoute('GET', '/hello/{name}', {
        path: HelloPath,
        response: Greeting,
      });
      const {fetch} = fakeFetch(500, {
        error: {statusCode: 500, message: 'oops'},
      });
      const client = createClient({baseURL: 'http://api.test', fetch});

      const result = await hello.safeCall(client, {path: {name: 'x'}});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBeInstanceOf(ClientError);
        expect(result.error.status).toBe(500);
      }
    });

    it('returns {success: false, error} on input validation failure', async () => {
      const hello = defineRoute('GET', '/hello/{name}', {
        path: HelloPath,
        response: Greeting,
      });
      const {fetch} = fakeFetch(200, {});
      const client = createClient({baseURL: 'http://api.test', fetch});

      const result = await hello.safeCall(client, {path: {name: ''}});

      expect(result.success).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('timeouts', () => {
    it('per-call timeoutMs aborts when the server is slow', async () => {
      const slow = defineRoute('GET', '/slow', {});
      const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        // Resolve when the signal aborts, so we can assert the abort path.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'TimeoutError';
            reject(e);
          });
        });
      });
      const client = createClient({
        baseURL: 'http://api.test',
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      const err = await slow
        .call(client, undefined, {timeoutMs: 10})
        .catch(e => e);

      expect(err).toBeInstanceOf(ClientError);
      expect((err as ClientError).status).toBe(0);
      expect((err as ClientError).message).toMatch(/Request aborted/);
    });

    it('client default timeoutMs applies when the call has none', async () => {
      const slow = defineRoute('GET', '/slow', {});
      const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'TimeoutError';
            reject(e);
          });
        });
      });
      const client = createClient({
        baseURL: 'http://api.test',
        fetch: fetch as unknown as typeof globalThis.fetch,
        timeoutMs: 10,
      });

      const err = await slow.call(client, undefined).catch(e => e);
      expect((err as ClientError).status).toBe(0);
    });

    it('explicit signal takes precedence over timeoutMs', async () => {
      const ping = defineRoute('GET', '/ping', {});
      const {fetch, calls} = fakeFetch(200, {});
      const client = createClient({
        baseURL: 'http://api.test',
        fetch,
        timeoutMs: 10,
      });
      const ac = new AbortController();

      await ping.call(client, undefined, {signal: ac.signal, timeoutMs: 5});

      // The signal forwarded to fetch must be the caller's, not a derived one.
      expect(calls[0]?.[1].signal).toBe(ac.signal);
    });
  });

  describe('typed error responses', () => {
    const ValidationError = z.object({
      error: z.object({
        statusCode: z.number(),
        message: z.string(),
        details: z.array(
          z.object({path: z.array(z.string()), code: z.string()}),
        ),
      }),
    });

    it('attaches parsedBody when the response status matches a schema', async () => {
      const create = defineRoute('POST', '/items', {
        body: z.object({name: z.string()}),
        responses: {422: ValidationError},
      });
      const errPayload = {
        error: {
          statusCode: 422,
          message: 'Invalid',
          details: [{path: ['name'], code: 'too_small'}],
        },
      };
      const {fetch} = fakeFetch(422, errPayload);
      const client = createClient({baseURL: 'http://api.test', fetch});

      const err = (await create
        .call(client, {body: {name: 'x'}})
        .catch((e: unknown) => e)) as ClientError;

      expect(err.status).toBe(422);
      expect(err.parsedBody).toEqual(errPayload);
      expect(err.body).toEqual(errPayload);
    });

    it('parsedBody is undefined when no schema matches the status', async () => {
      const create = defineRoute('POST', '/items', {
        body: z.object({name: z.string()}),
        responses: {422: ValidationError},
      });
      const {fetch} = fakeFetch(500, {
        error: {statusCode: 500, message: 'oops'},
      });
      const client = createClient({baseURL: 'http://api.test', fetch});

      const err = (await create
        .call(client, {body: {name: 'x'}})
        .catch((e: unknown) => e)) as ClientError;

      expect(err.status).toBe(500);
      expect(err.parsedBody).toBeUndefined();
    });

    it('parsedBody is undefined when the schema does not match the actual body', async () => {
      const create = defineRoute('POST', '/items', {
        body: z.object({name: z.string()}),
        responses: {422: ValidationError},
      });
      // Server returned a 422 but with a different shape than the schema.
      const {fetch} = fakeFetch(422, {nope: true});
      const client = createClient({baseURL: 'http://api.test', fetch});

      const err = (await create
        .call(client, {body: {name: 'x'}})
        .catch((e: unknown) => e)) as ClientError;

      expect(err.parsedBody).toBeUndefined();
      expect(err.body).toEqual({nope: true});
    });
  });

  describe('url', () => {
    it('composes the full URL without firing a request', () => {
      const hello = defineRoute('GET', '/greet/hello/{name}', {
        path: HelloPath,
        response: Greeting,
      });
      const {fetch} = fakeFetch(200, {});
      const client = createClient({baseURL: 'http://api.test', fetch});

      const url = hello.url(client, {path: {name: 'Alice'}});

      expect(url).toBe('http://api.test/greet/hello/Alice');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('appends a querystring when query schema is declared', () => {
      const list = defineRoute('GET', '/list', {query: FilterQuery});
      const {fetch} = fakeFetch(200, {});
      const client = createClient({baseURL: 'http://api.test', fetch});

      const url = list.url(client, {query: {limit: 10, tag: ['x']}});

      expect(url).toBe('http://api.test/list?limit=10&tag=x');
    });

    it('throws on bad path input — never reaches fetch', () => {
      const hello = defineRoute('GET', '/hello/{name}', {
        path: HelloPath,
        response: Greeting,
      });
      const {fetch} = fakeFetch(200, {});
      const client = createClient({baseURL: 'http://api.test', fetch});

      expect(() => hello.url(client, {path: {name: ''}})).toThrow(ClientError);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
