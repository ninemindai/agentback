// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {Context} from '@agentback/context';
import {CoreTags} from '@agentback/core';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import {Router} from '../../web/router.js';
import {createFetchHost} from '../../host/fetch.js';
import {RestHandler} from '../../web/rest-handler.js';
import type {RouteValue} from '../../web/route-value.js';

const GreetPath = z.object({name: z.string().min(1)});
const CreateBody = z.object({title: z.string().min(1), count: z.number()});

class DemoController {
  greet(input: {path: z.infer<typeof GreetPath>}) {
    return {greeting: `hi ${input.path.name}`};
  }

  create(input: {body: z.infer<typeof CreateBody>}) {
    return {id: 'abc', title: input.body.title, count: input.body.count};
  }

  boom() {
    throw new AgentError('You must pick a city.', {
      code: ErrorCodes.INVALID_INPUT,
    });
  }
}

function buildHost() {
  const ctx = new Context('test-root');
  ctx
    .bind('controllers.DemoController')
    .toClass(DemoController)
    .tag(CoreTags.CONTROLLER);
  const handler = new RestHandler(ctx);
  const router = new Router<RouteValue>();
  router.add({
    method: 'GET',
    template: '/greet/{name}',
    value: {
      ctor: DemoController,
      methodName: 'greet',
      schemas: {path: GreetPath, response: z.object({greeting: z.string()})},
      successStatus: 200,
    },
  });
  router.add({
    method: 'POST',
    template: '/items',
    value: {
      ctor: DemoController,
      methodName: 'create',
      schemas: {body: CreateBody},
      successStatus: 201,
    },
  });
  router.add({
    method: 'GET',
    template: '/boom',
    value: {
      ctor: DemoController,
      methodName: 'boom',
      schemas: {},
      successStatus: 200,
    },
  });
  return createFetchHost({router, dispatch: handler.dispatch});
}

describe('RestHandler core dispatch', () => {
  it('GET validates a path param and returns the result', async () => {
    const host = buildHost();
    const res = await host.fetch(
      new Request('http://x/greet/Ada', {method: 'GET'}),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({greeting: 'hi Ada'});
  });

  it('POST validates a JSON body and returns the success status', async () => {
    const host = buildHost();
    const res = await host.fetch(
      new Request('http://x/items', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({title: 'Widget', count: 3}),
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({id: 'abc', title: 'Widget', count: 3});
  });

  it('invalid JSON body → 422 envelope with code + issues', async () => {
    const host = buildHost();
    const res = await host.fetch(
      new Request('http://x/items', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({title: '', count: 'nope'}),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: {code: string; issues: unknown[]; details: unknown[]};
    };
    expect(typeof body.error.code).toBe('string');
    expect(body.error.code).toBe(ErrorCodes.INVALID_BODY);
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(body.error.details).toEqual(body.error.issues);
  });

  it('AgentError(INVALID_INPUT) → 400 + code invalid_input + message', async () => {
    const host = buildHost();
    const res = await host.fetch(new Request('http://x/boom', {method: 'GET'}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {code: string; message: string};
    };
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toBe('You must pick a city.');
  });
});
