// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Context} from '@agentback/core';
import {
  AuthenticationBindings,
  type AuthenticationResult,
  type AuthenticationStrategy,
} from '@agentback/authentication';
import {
  securityId,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {Request, Response} from 'express';
import {frameworkAuthGuard} from '../../framework-auth.js';

type StubReturn = UserProfile | AuthenticationResult | undefined;

class StubStrategy implements AuthenticationStrategy {
  constructor(
    public name: string,
    private result: StubReturn | Error,
  ) {}
  async authenticate(): Promise<
    UserProfile | AuthenticationResult | undefined
  > {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function ctxWith(...strategies: AuthenticationStrategy[]): Context {
  const ctx = new Context('test');
  strategies.forEach((s, i) =>
    ctx.bind(`strategies.${i}`).to(s).tag(AuthenticationBindings.AUTH_STRATEGY),
  );
  return ctx;
}

interface RunResult {
  nextCalled: boolean;
  status?: number;
  body?: {error?: {code?: number}};
  auth?: {clientId: string; scopes: string[]; extra?: unknown};
}

function run(
  mw: ReturnType<typeof frameworkAuthGuard>,
  req: Partial<Request>,
): Promise<RunResult> {
  return new Promise(resolve => {
    let status: number | undefined;
    const res = {
      status(c: number) {
        status = c;
        return res;
      },
      json(b: unknown) {
        resolve({
          nextCalled: false,
          status,
          body: b as RunResult['body'],
          auth: (req as {auth?: RunResult['auth']}).auth,
        });
        return res;
      },
      set() {
        return res;
      },
    } as unknown as Response;
    mw(req as Request, res, () =>
      resolve({
        nextCalled: true,
        auth: (req as {auth?: RunResult['auth']}).auth,
      }),
    );
  });
}

describe('frameworkAuthGuard', () => {
  it('sets req.auth (clientId + scopes) from the authenticating strategy', async () => {
    const user: UserProfile & {scopes: string[]} = {
      [securityId]: 'u1',
      scopes: ['orders:read'],
    };
    const mw = frameworkAuthGuard({
      context: ctxWith(new StubStrategy('jwt', user)),
      strategy: 'jwt',
    });
    const r = await run(mw, {headers: {}});
    expect(r.nextCalled).toBe(true);
    expect(r.auth?.clientId).toBe('u1');
    expect(r.auth?.scopes).toEqual(['orders:read']);
  });

  it('derives scopes from a client application allowedScopes', async () => {
    const app: ClientApplication = {
      [securityId]: 'app1',
      allowedScopes: ['a', 'b'],
    };
    const mw = frameworkAuthGuard({
      context: ctxWith(
        new StubStrategy('client-credentials', {
          user: app,
          clientApplication: app,
        }),
      ),
      strategy: 'client-credentials',
    });
    const r = await run(mw, {headers: {}});
    expect(r.auth?.clientId).toBe('app1');
    expect(r.auth?.scopes).toEqual(['a', 'b']);
  });

  it('tries strategies in order', async () => {
    const user: UserProfile & {scopes: string[]} = {
      [securityId]: 'u',
      scopes: ['z'],
    };
    const mw = frameworkAuthGuard({
      context: ctxWith(
        new StubStrategy('api-key', undefined), // declines
        new StubStrategy('jwt', user), // wins
      ),
      strategy: ['api-key', 'jwt'],
    });
    const r = await run(mw, {headers: {}});
    expect(r.auth?.clientId).toBe('u');
  });

  it('401s when no strategy authenticates (required)', async () => {
    const mw = frameworkAuthGuard({
      context: ctxWith(new StubStrategy('jwt', undefined)),
      strategy: 'jwt',
    });
    const r = await run(mw, {headers: {}});
    expect(r.status).toBe(401);
    expect(r.body?.error?.code).toBe(-32001);
  });

  it('401s when the strategy throws (required)', async () => {
    const mw = frameworkAuthGuard({
      context: ctxWith(new StubStrategy('jwt', new Error('bad token'))),
      strategy: 'jwt',
    });
    expect((await run(mw, {headers: {}})).status).toBe(401);
  });

  it('passes through when optional and unauthenticated', async () => {
    const mw = frameworkAuthGuard({
      context: ctxWith(new StubStrategy('jwt', undefined)),
      strategy: 'jwt',
      required: false,
    });
    const r = await run(mw, {headers: {}});
    expect(r.nextCalled).toBe(true);
    expect(r.auth).toBeUndefined();
  });

  it('honors a custom scopes mapper', async () => {
    const app: ClientApplication = {[securityId]: 'app2', allowedScopes: ['x']};
    const mw = frameworkAuthGuard({
      context: ctxWith(
        new StubStrategy('cc', {user: app, clientApplication: app}),
      ),
      strategy: 'cc',
      scopes: () => ['custom:scope'],
    });
    expect((await run(mw, {headers: {}})).auth?.scopes).toEqual([
      'custom:scope',
    ]);
  });
});
