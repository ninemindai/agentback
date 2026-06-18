// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Hello, OAuth2 — proves OAuth2-protected REST end-to-end: opaque bearer tokens
// validated via RFC 7662 introspection, user vs. client-credentials principals,
// and scope enforcement. Authorization-server agnostic.
//
// For a self-contained demo this file stands in a tiny in-process authorization
// server via the OAuth2Bindings.FETCH seam, so no external AS or network is
// needed. In production you DROP the FETCH override and point
// OAuth2Bindings.CONFIG.introspectionUrl at your real AS (Keycloak/Okta/...).

import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {installExplorer} from '@agentback/rest-explorer';
import {authenticate} from '@agentback/authentication';
import {requireScopes} from '@agentback/authorization';
import {
  OAuth2AuthenticationComponent,
  OAuth2Bindings,
  type FetchLike,
  type IntrospectionResponse,
} from '@agentback/authentication-oauth2';
import {inject, isMain} from '@agentback/core';
import {
  ClientApplication,
  securityId,
  SecurityBindings,
  UserProfile,
} from '@agentback/security';
import {
  MeteringComponent,
  MeteringBindings,
  type InMemoryUsageSink,
} from '@agentback/metering';

// Schemas must be declared before the controller — the @get/@post decorators
// reference them at class-definition time.
const WhoAmI = z.object({
  principal: z.string(),
  kind: z.enum(['user', 'client']),
  scopes: z.array(z.string()),
});
const NewWidget = z.object({name: z.string().min(1)});
const WidgetOut = z.object({id: z.string(), name: z.string()});
const UsageReport = z.object({
  events: z.array(
    z.object({
      operation: z.string(),
      principal: z.string(),
      kind: z.string(),
      status: z.string(),
      at: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Stand-in authorization server (demo only).
//
// A real AS issues opaque tokens and exposes an RFC 7662 introspection
// endpoint. Here we model both as an in-memory token table plus a FETCH that
// answers introspection calls. `tok_alice` is a user with write scope;
// `tok_bob` is a read-only user; `tok_svc` is a machine client (no `sub`).
// ---------------------------------------------------------------------------
const TOKEN_TABLE: Record<string, IntrospectionResponse> = {
  tok_alice: {
    active: true,
    sub: 'user-alice',
    username: 'alice',
    scope: 'widgets:read widgets:write',
  },
  tok_bob: {
    active: true,
    sub: 'user-bob',
    username: 'bob',
    scope: 'widgets:read',
  },
  // Client-credentials grant — no `sub`, identified by `client_id`.
  tok_svc: {
    active: true,
    client_id: 'svc-importer',
    scope: 'widgets:read',
  },
};

/** A `fetch` that emulates the AS's RFC 7662 introspection endpoint. */
const fakeAuthServer: FetchLike = async (_url, init) => {
  const body =
    init?.body instanceof URLSearchParams
      ? init.body
      : new URLSearchParams(String(init?.body ?? ''));
  const token = body.get('token') ?? '';
  const claims: IntrospectionResponse = TOKEN_TABLE[token] ?? {active: false};
  return {ok: true, status: 200, json: async () => claims};
};

@api({basePath: '/widgets'})
class WidgetController {
  /**
   * Any valid token — returns who you are and the scopes you hold. The opaque
   * token may be a user (`sub`) or a machine client (`client_id`); the strategy
   * binds the matching principal, so exactly one of these injects resolves.
   */
  @authenticate('oauth2')
  @get('/', {response: WhoAmI})
  async list(
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
    @inject(SecurityBindings.CLIENT_APPLICATION, {optional: true})
    app?: ClientApplication,
  ): Promise<z.infer<typeof WhoAmI>> {
    const principal = (user ?? app)!;
    const scopes =
      (user as (UserProfile & {scopes?: string[]}) | undefined)?.scopes ??
      app?.allowedScopes ??
      [];
    return {
      principal: principal[securityId],
      kind: user ? 'user' : 'client',
      scopes,
    };
  }

  /**
   * Requires the `widgets:write` scope from the token. `@requireScopes` checks
   * the scopes the access token carries (parsed from the RFC 7662 `scope`
   * claim) against the route's requirement: `tok_alice` (read+write) → 200,
   * `tok_bob` (read only) → 403.
   */
  @authenticate('oauth2')
  @requireScopes('widgets:write')
  @post('/', {body: NewWidget, response: WidgetOut})
  async create(input: {
    body: z.infer<typeof NewWidget>;
  }): Promise<z.infer<typeof WidgetOut>> {
    return {id: 'w_1', name: input.body.name};
  }
}

// Reads the metering sink — every call above is recorded as a UsageEvent,
// attributed to the OAuth2 principal that authenticated it. The auth principal
// is the billable identity, so metering and billing fall out of the auth layer.
@api({basePath: '/admin'})
class UsageController {
  @get('/usage', {response: UsageReport})
  async usage(
    @inject(MeteringBindings.SINK) sink: InMemoryUsageSink,
  ): Promise<z.infer<typeof UsageReport>> {
    return {
      events: sink.all().map(e => ({
        operation: e.operation,
        principal: e.principal.id,
        kind: e.principal.kind,
        status: e.status,
        at: e.at,
      })),
    };
  }
}

async function main() {
  const app = new RestApplication({});

  // Usage metering: the component binds the in-memory metering stack AND the
  // REST/MCP dispatch hooks — every dispatched call now emits a UsageEvent
  // attributed to its principal. See GET /admin/usage.
  app.component(MeteringComponent);

  // OAuth2 resource-server wiring. In production, set introspectionUrl to your
  // AS and supply this resource server's own client credentials — and remove
  // the FETCH override below.
  app.bind(OAuth2Bindings.CONFIG).to({
    introspectionUrl:
      process.env.OAUTH2_INTROSPECTION_URL ??
      'https://auth.example.com/oauth2/introspect',
    clientId: process.env.OAUTH2_CLIENT_ID ?? 'hello-oauth2-rs',
    clientSecret: process.env.OAUTH2_CLIENT_SECRET ?? 'rs-secret',
    // Amortize the per-request introspection round-trip. Cached results are
    // keyed by a SHA-256 digest of the token, bounded by the token's `exp`.
    cache: {ttlSeconds: 30},
  });
  // DEMO ONLY: stand in the authorization server in-process. Delete this line
  // to hit the real introspectionUrl above.
  app.bind(OAuth2Bindings.FETCH).to(fakeAuthServer);
  app.component(OAuth2AuthenticationComponent);

  app.restController(WidgetController);
  app.restController(UsageController);

  await installExplorer(app, {title: 'hello-oauth2 API'});
  await app.start();

  const server = await app.restServer;
  console.log(`hello-oauth2 listening at ${server.url}`);
  console.log(`  Opaque bearer tokens minted by the in-process AS:`);
  console.log(
    `    curl ${server.url}/widgets/ -H 'authorization: Bearer tok_alice'   → 200 user alice (read+write)`,
  );
  console.log(
    `    curl ${server.url}/widgets/ -H 'authorization: Bearer tok_svc'     → 200 client svc-importer`,
  );
  console.log(
    `    curl -X POST ${server.url}/widgets/ -H 'authorization: Bearer tok_alice' -H 'content-type: application/json' -d '{"name":"x"}'   → 200`,
  );
  console.log(
    `    curl -X POST ${server.url}/widgets/ -H 'authorization: Bearer tok_bob'  -H 'content-type: application/json' -d '{"name":"x"}'   → 403 (no widgets:write)`,
  );
  console.log(
    `    curl ${server.url}/widgets/ -H 'authorization: Bearer nope'         → 401 (inactive token)`,
  );
  console.log(
    `    curl ${server.url}/widgets/                                → 401 (no token)`,
  );
  console.log(`  Metering — every call above is recorded + attributed:`);
  console.log(
    `    curl ${server.url}/admin/usage                             → usage events per principal`,
  );
  console.log(`    open ${server.url}/explorer/`);
}

if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
