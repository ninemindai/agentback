// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-client — exercises @agentback/client against a running
// hello-rest server. Imports the very same Zod schemas the server uses;
// no codegen, no separate generated SDK, no spec round-trip.
//
// Usage:
//   1. In one terminal: `pnpm -F hello-rest start`
//   2. In another:      `pnpm -F hello-client start`

import {pathToFileURL} from 'node:url';
import {createClient, routeGroup} from '@agentback/client';
import {
  EchoIn,
  EchoOut,
  Greeting,
  HelloPath,
  LoginIn,
  LoginOut,
  Me,
  Secret,
} from 'hello-rest/schemas';

const baseURL = process.env.HELLO_REST_URL ?? 'http://localhost:3000';

// ----- Route handles: schema-typed, no codegen, grouped by basePath -----

const greet = routeGroup('/greet');
const auth = routeGroup('/auth');

const hello = greet.get('/hello/{name}', {path: HelloPath, response: Greeting});
const echo = greet.post('/echo', {body: EchoIn, response: EchoOut});

const login = auth.post('/login', {body: LoginIn, response: LoginOut});
const me = auth.get('/me', {response: Me});
const secret = auth.get('/secret', {response: Secret});

async function main() {
  // Anonymous client for unauthenticated endpoints.
  const anon = createClient({baseURL});

  // .url() composes the full URL without firing a request — handy for
  // links, logs, or pre-flight inspection.
  console.log('would call', hello.url(anon, {path: {name: 'world'}}));

  const greeting = await hello.call(anon, {path: {name: 'world'}});
  console.log('hello →', greeting);
  //          ^^^^^^^^  inferred as {greeting: string}

  const echoed = await echo.call(anon, {body: {text: 'ping'}});
  console.log('echo  →', echoed);

  // Demo "login" mints a JWT with whatever roles you ask for.
  const {token} = await login.call(anon, {
    body: {username: 'alice', roles: ['admin']},
  });

  // Authenticated client — header function is async-capable so a real app
  // can refresh tokens on demand.
  const authed = createClient({
    baseURL,
    headers: () => ({authorization: `Bearer ${token}`}),
  });

  console.log('me     →', await me.call(authed));
  console.log('secret →', await secret.call(authed));

  // .safeCall returns a discriminated result instead of throwing —
  // mirrors Zod's safeParse. Useful when a non-2xx is an expected path.
  const result = await secret.safeCall(anon);
  if (!result.success) {
    console.log(`secret (anon) → blocked: ${result.error.status}`);
  } else {
    console.log('secret (anon) →', result.data);
  }
}

// Boot only when this module is the entry point, not when imported. This demo
// deliberately depends on nothing but the browser-safe client + shared schemas,
// so the guard is inlined here instead of pulling a helper from the framework.
// Prefer the native `import.meta.main` flag (Node 24.2+); fall back to comparing
// the module URL against argv on the project's Node 22.13 floor.
const isEntry =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : process.argv[1] != null &&
      import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  try {
    await main();
  } catch (err) {
    console.error('hello-client failed:', err);
    process.exit(1);
  }
}
