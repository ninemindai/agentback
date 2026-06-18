// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {IncomingMessage} from 'node:http';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {FetchHost} from './fetch.js';
import {writeWebResponseToNode} from './node-response.js';

/**
 * Mount a {@link FetchHost} onto a user-owned Fastify instance as a
 * **non-greedy fallback**: Fastify's own routes and plugins front-run, and only
 * requests Fastify itself can't match more specifically fall through to the
 * AgentBack core. This is the inverse of "AgentBack owns the server" — here
 * Fastify owns it and AgentBack is the catch-all, mirroring the Express
 * demotion path where the core is mounted behind everything the user
 * registered.
 *
 * Wiring:
 * - **Non-greedy fallback** is a catch-all wildcard route, `all('/*')` (plus the
 *   root `'/'`, which `'/*'` does not cover), registered inside an
 *   **encapsulated** Fastify plugin scope (`fastify.register`). Fastify's radix
 *   router always prefers a more specific route over the wildcard, so any
 *   Fastify-native route or plugin takes precedence automatically. (Fastify's
 *   `setNotFoundHandler` is *not* used: in Fastify v5 the 404 path skips body
 *   parsing entirely and drains the request stream before the handler runs, so
 *   the body would be lost — a real wildcard route goes through the normal
 *   parse lifecycle and keeps it.)
 * - **Body passthrough**: inside the encapsulated scope we drop the inherited
 *   content-type parsers and install a single `'*'` parser with
 *   `parseAs: 'buffer'`, so the fallback handler sees the raw bytes
 *   (`request.body` is a `Buffer`) for *every* content type and can rebuild the
 *   Web `Request` body verbatim. Encapsulation keeps this scoped: the user's own
 *   routes outside the scope keep their normal parsers (e.g. JSON → object).
 * - **Node↔Web conversion**: the request half rebuilds a Web `Request` from
 *   `request.raw`'s method/url/headers plus the buffered body; the response
 *   half reuses the shared {@link writeWebResponseToNode} — the exact same
 *   writer the Express web-dispatch path delegates to — to write the Web
 *   `Response` back onto `reply.raw` (a Node `ServerResponse`): status, headers
 *   (incl. Set-Cookie multiplicity), and `ReadableStream` bodies.
 *   `reply.hijack()` tells Fastify not to also send a response on the socket.
 *
 * `fastify` is a **devDependency** of `@agentback/rest` (types + the test
 * only); the instance is supplied by the caller, so Fastify is never a hard
 * runtime dependency of the package.
 */
export function installFastifyHost(
  fastify: FastifyInstance,
  host: FetchHost,
): void {
  const fallback = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    // Fastify must not also write to the socket — we own `reply.raw`.
    reply.hijack();
    const body = Buffer.isBuffer(request.body) ? request.body : undefined;
    const webReq = toWebRequest(request.raw, body);
    const webRes = await host.fetch(webReq);
    await writeWebResponseToNode(reply.raw, webRes);
  };

  // Encapsulated scope: the buffer parser + wildcard routes live here so they
  // don't change body parsing for the user's own routes registered elsewhere.
  void fastify.register(async instance => {
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser(
      '*',
      {parseAs: 'buffer'},
      (_request, body, done) => done(null, body as Buffer),
    );
    // `'/*'` catches every nested path; `'/'` is registered separately because
    // the wildcard does not match the bare root. Both yield to more specific
    // routes registered on the parent instance.
    instance.all('/*', fallback);
    instance.all('/', fallback);
  });
}

/** Rebuild a Web `Request` from a Node `IncomingMessage` (+ buffered body). */
function toWebRequest(
  incoming: IncomingMessage,
  body: Buffer | undefined,
): Request {
  const hostHeader = incoming.headers.host ?? 'localhost';
  const scheme =
    (incoming.socket as {encrypted?: boolean} | undefined)?.encrypted === true
      ? 'https'
      : 'http';
  const url = `${scheme}://${hostHeader}${incoming.url ?? '/'}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }

  const method = incoming.method ?? 'GET';
  const init: RequestInit = {method, headers};
  // GET/HEAD must not carry a body. For other methods, attach the buffered body
  // captured by the content-type parser (omitted when empty).
  if (method !== 'GET' && method !== 'HEAD' && body && body.length > 0) {
    init.body = body;
  }
  return new Request(url, init);
}
