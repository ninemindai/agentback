// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Hello, REST — proves the AgentBack stack end-to-end: ESM + Zod +
// OpenAPI 3.1.1 + auth (JWT/RBAC, anonymous, api-key, client-credentials +
// client-app scope governance) + health + Prometheus metrics.

import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {installExplorer} from '@agentback/rest-explorer';
import {installContextExplorer} from '@agentback/context-explorer';
import {
  authenticate,
  AuthenticationBindings,
  AnonymousAuthenticationStrategy,
  ApiKeyAuthenticationStrategy,
  API_KEY_VERIFIER,
  ClientCredentialsAuthenticationStrategy,
  CLIENT_CREDENTIALS_VERIFIER,
} from '@agentback/authentication';
import {
  authorize,
  clientAppScopeVoter,
  GLOBAL_VOTER_TAG,
  requireScopes,
} from '@agentback/authorization';
import {
  JWTAuthenticationComponent,
  JWTBindings,
  JWTService,
} from '@agentback/authentication-jwt';
import {
  installHealth,
  registerHealthCheck,
} from '@agentback/extension-health';
import {installMetrics} from '@agentback/extension-metrics';
import {installRateLimit} from '@agentback/extension-rate-limit';
import {inject, isMain} from '@agentback/core';
import {
  ClientApplication,
  securityId,
  SecurityBindings,
  UserProfile,
} from '@agentback/security';
import {
  EchoIn,
  EchoOut,
  Greeting,
  HelloPath,
  LoginIn,
  LoginOut,
  Me,
  OrdersReport,
  PrincipalOut,
  Secret,
} from './schemas.js';

@api({basePath: '/greet'})
class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {
    body: EchoIn,
    response: EchoOut,
    description: 'Echoed input',
  })
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text, at: new Date().toISOString()};
  }
}

@api({basePath: '/auth'})
class AuthController {
  constructor(@inject(JWTBindings.SERVICE) private jwt: JWTService) {}

  /** Demo "login": no password check — mints a token with the supplied roles. */
  @post('/login', {body: LoginIn, response: LoginOut})
  async login(input: {
    body: z.infer<typeof LoginIn>;
  }): Promise<z.infer<typeof LoginOut>> {
    const token = await this.jwt.generateToken({
      [securityId]: input.body.username,
      name: input.body.username,
      roles: input.body.roles ?? [],
    } as UserProfile);
    return {token};
  }

  /** Any authenticated user. */
  @authenticate('jwt')
  @get('/me', {response: Me})
  async me(
    @inject(SecurityBindings.USER) user: UserProfile,
  ): Promise<z.infer<typeof Me>> {
    const roles = (user as UserProfile & {roles?: string[]}).roles ?? [];
    return {id: user[securityId], name: user.name ?? '', roles};
  }

  /** Authenticated AND must have the 'admin' role. */
  @authenticate('jwt')
  @authorize({allowedRoles: ['admin']})
  @get('/secret', {response: Secret})
  async secret(): Promise<z.infer<typeof Secret>> {
    return {secret: '🐇 the rabbit hole goes deeper.'};
  }
}

// Machine-to-machine auth: anonymous fallback, API keys, and OAuth2-style
// client credentials governed by per-application scope policy.
@api({basePath: '/svc'})
class ServiceController {
  /** Public route — `anonymous` never 401s; the principal is `$anonymous`. */
  @authenticate('anonymous')
  @get('/ping', {response: PrincipalOut})
  async ping(
    @inject(SecurityBindings.USER) user: UserProfile,
  ): Promise<z.infer<typeof PrincipalOut>> {
    return {ok: true, principal: user[securityId]};
  }

  /** Machine auth via API key — send `x-api-key: svc-key-123`. */
  @authenticate('api-key')
  @get('/data', {response: PrincipalOut})
  async data(
    @inject(SecurityBindings.USER) user: UserProfile,
  ): Promise<z.infer<typeof PrincipalOut>> {
    return {ok: true, principal: user[securityId]};
  }

  /**
   * Client-credentials + client-application scope governance.
   * `@requireScopes` is the preset for `@authorize({scopes})`; the global
   * `clientAppScopeVoter` additionally checks the calling app is *permitted*
   * that scope — so `partner` (allowed orders:write) gets 200 while `readonly`
   * (allowed only orders:read) gets 403, even though both "hold" the grant.
   */
  @authenticate('client-credentials')
  @requireScopes('orders:write')
  @get('/orders', {response: OrdersReport})
  async orders(
    @inject(SecurityBindings.CLIENT_APPLICATION) app: ClientApplication,
  ): Promise<z.infer<typeof OrdersReport>> {
    return {ok: true, client: app[securityId], scope: 'orders:write'};
  }
}

// Demo client-application registry for the client-credentials verifier.
const CLIENT_APPS: Record<string, ClientApplication> = {
  partner: {
    [securityId]: 'partner',
    name: 'Partner',
    scopes: ['orders:write'], // the user-grant checked by defaultRoleVoter
    allowedScopes: ['orders:write'], // the app-grant checked by clientAppScopeVoter
  },
  // Holds the grant, but the application is only permitted orders:read → 403.
  readonly: {
    [securityId]: 'readonly',
    name: 'Read-only',
    scopes: ['orders:write'],
    allowedScopes: ['orders:read'],
  },
};

async function main() {
  const app = new RestApplication({});

  // JWT auth wiring
  app
    .bind(JWTBindings.SECRET)
    .to(process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod');
  app.bind(JWTBindings.EXPIRES_IN).to('1h');
  app.component(JWTAuthenticationComponent);

  // Machine-auth strategies. Each is bound with the AUTH_STRATEGY tag so the
  // REST server discovers it; the api-key / client-credentials strategies pick
  // up their verifier via DI (@inject of the *_VERIFIER binding below).
  app
    .bind(API_KEY_VERIFIER)
    .to((key: string) =>
      key === (process.env.API_KEY ?? 'svc-key-123')
        ? {[securityId]: 'service:reporting', name: 'reporting'}
        : undefined,
    );
  app
    .bind(CLIENT_CREDENTIALS_VERIFIER)
    .to((id: string, secret: string) =>
      secret === (process.env.CLIENT_SECRET ?? 'shh')
        ? CLIENT_APPS[id]
        : undefined,
    );
  app
    .bind('strategies.anonymous')
    .toClass(AnonymousAuthenticationStrategy)
    .tag(AuthenticationBindings.AUTH_STRATEGY);
  app
    .bind('strategies.apiKey')
    .toClass(ApiKeyAuthenticationStrategy)
    .tag(AuthenticationBindings.AUTH_STRATEGY);
  app
    .bind('strategies.clientCredentials')
    .toClass(ClientCredentialsAuthenticationStrategy)
    .tag(AuthenticationBindings.AUTH_STRATEGY);
  // Enforce client-application scope governance on every scoped route.
  app.bind('voters.clientScopes').to(clientAppScopeVoter).tag(GLOBAL_VOTER_TAG);

  app.restController(GreetingController);
  app.restController(AuthController);
  app.restController(ServiceController);

  // Health: register a readiness check that always passes; replace with real checks.
  registerHealthCheck(app, 'health.checks.startup', {
    name: 'startup',
    type: 'readiness',
    async check() {
      /* example: confirm DB connection / external dependency */
    },
  });

  await installExplorer(app, {title: 'hello-rest API'});
  await installContextExplorer(app, {title: 'hello-rest Context'});
  await installHealth(app);
  await installMetrics(app);
  // 100 requests / 60s per client IP (in-memory). Pass `store: redisClient`
  // to share the limit across instances.
  await installRateLimit(app, {points: 100, durationSecs: 60});
  await app.start();

  const server = await app.restServer;
  console.log(`hello-rest listening at ${server.url}`);
  console.log(`  REST:`);
  console.log(`    GET  ${server.url}/greet/hello/world`);
  console.log(`    POST ${server.url}/greet/echo`);
  console.log(`    POST ${server.url}/auth/login`);
  console.log(`    GET  ${server.url}/auth/me      (auth)`);
  console.log(`    GET  ${server.url}/auth/secret  (auth + admin role)`);
  console.log(`  Machine auth:`);
  console.log(`    GET  ${server.url}/svc/ping     (anonymous — no 401)`);
  console.log(`    GET  ${server.url}/svc/data     (x-api-key: svc-key-123)`);
  console.log(
    `    GET  ${server.url}/svc/orders   (client_id+client_secret: shh; partner→200, readonly→403)`,
  );
  console.log(`  Rate limit: 100 req / 60s per IP (429 + RateLimit-* headers)`);
  console.log(`  Operations:`);
  console.log(`    GET  ${server.url}/health`);
  console.log(`    GET  ${server.url}/ready`);
  console.log(`    GET  ${server.url}/metrics`);
  console.log(`    GET  ${server.url}/explorer/`);
  console.log(`    GET  ${server.url}/context-explorer/`);
}

// Boot only when this module is the entry point, not when imported.
if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
