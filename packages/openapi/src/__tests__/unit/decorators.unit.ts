// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {inject} from '@agentback/context';
import {api, del, get, patch, post, put} from '../../decorators/index.js';
import {OAI3Keys, RestEndpoint} from '../../keys.js';
import {lookupRouteSchemas} from '../../zod-bridge.js';
import {MetadataInspector} from '@agentback/metadata';

describe('@api', () => {
  it('attaches ControllerSpec metadata to the class', () => {
    @api({basePath: '/things', tags: ['things'], description: 'desc'})
    class ThingController {}

    const meta = MetadataInspector.getClassMetadata(
      OAI3Keys.CLASS_KEY,
      ThingController,
    );
    expect(meta).toMatchObject({
      basePath: '/things',
      tags: ['things'],
      description: 'desc',
    });
  });
});

describe('@get/@post/@put/@patch/@del', () => {
  it.each([
    ['get', get],
    ['post', post],
    ['put', put],
    ['patch', patch],
    ['delete', del],
  ] as const)('records verb %s and path on the method', (verb, decorator) => {
    class Ctrl {
      @decorator('/foo/{id}')
      method() {}
    }
    const meta = MetadataInspector.getMethodMetadata<RestEndpoint>(
      OAI3Keys.METHODS_KEY,
      Ctrl.prototype,
      'method',
    );
    expect(meta).toMatchObject({verb, path: '/foo/{id}'});
  });

  it('stores route options on the endpoint metadata', () => {
    const Body = z.object({text: z.string()});
    class Ctrl {
      @post('/echo', {body: Body, summary: 'echo', tags: ['demo']})
      method(_input: {body: z.infer<typeof Body>}) {}
    }
    const meta = MetadataInspector.getMethodMetadata<RestEndpoint>(
      OAI3Keys.METHODS_KEY,
      Ctrl.prototype,
      'method',
    );
    expect(meta?.options.body).toBe(Body);
    expect(meta?.options.summary).toBe('echo');
    expect(meta?.options.tags).toEqual(['demo']);
  });
});

describe('route schema registration', () => {
  it('registers body schema for the validator', () => {
    const Body = z.object({text: z.string()});
    class Ctrl {
      @post('/echo', {body: Body})
      method(_input: {body: z.infer<typeof Body>}) {}
    }
    const schemas = lookupRouteSchemas(Ctrl.prototype, 'method');
    expect(schemas?.body).toBe(Body);
  });

  it('registers path/query/headers schemas as Zod objects', () => {
    const Path = z.object({id: z.string().uuid()});
    const Query = z.object({limit: z.coerce.number().int()});
    const Headers = z.object({'x-trace': z.string()});
    class Ctrl {
      @get('/items/{id}', {path: Path, query: Query, headers: Headers})
      method(_input: {
        path: z.infer<typeof Path>;
        query: z.infer<typeof Query>;
        headers: z.infer<typeof Headers>;
      }) {}
    }
    const schemas = lookupRouteSchemas(Ctrl.prototype, 'method');
    expect(schemas?.path).toBe(Path);
    expect(schemas?.query).toBe(Query);
    expect(schemas?.headers).toBe(Headers);
  });

  it('registers response schema (single success case)', () => {
    const Out = z.object({ok: z.boolean()});
    class Ctrl {
      @get('/health', {response: Out})
      method(): {ok: boolean} {
        return {ok: true};
      }
    }
    const schemas = lookupRouteSchemas(Ctrl.prototype, 'method');
    expect(schemas?.response).toBe(Out);
  });
});

describe('slot-0 guard', () => {
  it('throws when @inject is on slot 0 alongside an input schema', () => {
    expect(() => {
      class _Bad {
        @post('/x', {body: z.object({})})
        bad(@inject('svc') _svc: unknown) {}
      }
      void _Bad;
    }).toThrow(/slot 0 is reserved for the validated input bundle/);
  });

  it('allows @inject on slot 0 when the route declares no input schemas', () => {
    expect(() => {
      class Ok {
        @get('/whoami')
        whoami(@inject('user') _user: unknown) {}
      }
      void Ok;
    }).not.toThrow();
  });
});
