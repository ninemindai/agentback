// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import type {Request, Response} from 'express';
import {z} from 'zod';
import {get} from '@agentback/openapi';
import type {RouteSchemas} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import {RestServer} from '../../rest.server.js';
import {REST_DISPATCH_HOOK_TAG, type RestDispatchHook} from '../../keys.js';

const Ok = z.object({ok: z.boolean()});

class WidgetController {
  @get('/ok', {response: Ok})
  async ok(): Promise<z.infer<typeof Ok>> {
    return {ok: true};
  }

  @get('/fail')
  async fail(): Promise<never> {
    throw Object.assign(new Error('service melted'), {statusCode: 503});
  }
}

function recordingHook(name: string, records: string[]): RestDispatchHook {
  return async (info, next) => {
    records.push(`${name}:before:${info.ctor.name}.${info.methodName}`);
    try {
      return await next();
    } finally {
      records.push(`${name}:after:${info.ctor.name}.${info.methodName}`);
    }
  };
}

describe('REST dispatch hooks (integration)', () => {
  let app: RestApplication;
  let records: string[];

  beforeEach(() => {
    records = [];
  });

  afterEach(async () => {
    await app.stop();
  });

  async function startApp(serverClass?: typeof RestServer) {
    app = new RestApplication({});
    if (serverClass) app.server(serverClass, 'RestServer');
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(WidgetController);
    return app;
  }

  async function clientFor(a: RestApplication) {
    await a.start();
    const server = await a.restServer;
    return supertest(server.url);
  }

  it('two hooks compose as an onion in bind order (first bound outermost)', async () => {
    await startApp();
    app
      .bind('hooks.first')
      .to(recordingHook('first', records))
      .tag(REST_DISPATCH_HOOK_TAG);
    app
      .bind('hooks.second')
      .to(recordingHook('second', records))
      .tag(REST_DISPATCH_HOOK_TAG);
    const client = await clientFor(app);
    const r = await client.get('/ok').expect(200);
    expect(r.body).toEqual({ok: true});
    expect(records).toEqual([
      'first:before:WidgetController.ok',
      'second:before:WidgetController.ok',
      'second:after:WidgetController.ok',
      'first:after:WidgetController.ok',
    ]);
  });

  it('hooks see handler errors as thrown errors (and the error still maps to HTTP)', async () => {
    await startApp();
    const seen: Error[] = [];
    const hook: RestDispatchHook = async (_info, next) => {
      try {
        return await next();
      } catch (err) {
        seen.push(err as Error);
        throw err;
      }
    };
    app.bind('hooks.observer').to(hook).tag(REST_DISPATCH_HOOK_TAG);
    const client = await clientFor(app);
    await client.get('/fail').expect(503);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toBe('service melted');
  });

  it('hooks and a dispatch-overriding subclass coexist (subclass wraps the hook chain)', async () => {
    // The subclass composition shape: override dispatch,
    // call super.dispatch. The override runs OUTSIDE the hook chain.
    class AuditRestServer extends RestServer {
      protected async dispatch(
        req: Request,
        res: Response,
        ctor: Function,
        methodName: string,
        schemas: RouteSchemas,
      ): Promise<unknown> {
        records.push(`subclass:before:${ctor.name}.${methodName}`);
        try {
          return await super.dispatch(req, res, ctor, methodName, schemas);
        } finally {
          records.push(`subclass:after:${ctor.name}.${methodName}`);
        }
      }
    }
    await startApp(AuditRestServer);
    app
      .bind('hooks.inner')
      .to(recordingHook('hook', records))
      .tag(REST_DISPATCH_HOOK_TAG);
    const client = await clientFor(app);
    const r = await client.get('/ok').expect(200);
    expect(r.body).toEqual({ok: true});
    expect(records).toEqual([
      'subclass:before:WidgetController.ok',
      'hook:before:WidgetController.ok',
      'hook:after:WidgetController.ok',
      'subclass:after:WidgetController.ok',
    ]);
  });

  it('exposes the per-request context to hooks via info.ctx', async () => {
    await startApp();
    let sawCtx = false;
    const hook: RestDispatchHook = async (info, next) => {
      sawCtx = info.ctx != null && info.ctx !== (app as unknown);
      return next();
    };
    app.bind('hooks.ctx').to(hook).tag(REST_DISPATCH_HOOK_TAG);
    const client = await clientFor(app);
    await client.get('/ok').expect(200);
    expect(sawCtx).toBe(true);
  });

  it('hooks bound after the first request are NOT picked up (documented caching)', async () => {
    await startApp();
    app
      .bind('hooks.early')
      .to(recordingHook('early', records))
      .tag(REST_DISPATCH_HOOK_TAG);
    const client = await clientFor(app);
    await client.get('/ok').expect(200);
    app
      .bind('hooks.late')
      .to(recordingHook('late', records))
      .tag(REST_DISPATCH_HOOK_TAG);
    await client.get('/ok').expect(200);
    expect(records.filter(r => r.startsWith('late:'))).toEqual([]);
    expect(
      records.filter(r => r === 'early:before:WidgetController.ok'),
    ).toHaveLength(2);
  });
});
