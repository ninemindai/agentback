// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '../../decorators/index.js';
import {assembleOpenApiSpec, getControllerSpec} from '../../controller-spec.js';
import {lookupRouteSchemas} from '../../zod-bridge.js';

const Tick = z.object({n: z.number().int()});

describe('streamOf routes', () => {
  it('records streamOf in the route registry', () => {
    @api({basePath: '/s'})
    class C {
      @get('/ticks', {streamOf: Tick})
      async *ticks(): AsyncGenerator<z.infer<typeof Tick>> {
        yield {n: 1};
      }
    }
    const schemas = lookupRouteSchemas(C.prototype, 'ticks');
    expect(schemas?.streamOf).toBe(Tick);
    expect(schemas?.response).toBeUndefined();
  });

  it('emits text/event-stream with x-itemSchema (not bare itemSchema)', () => {
    @api({basePath: '/s'})
    class C {
      @get('/ticks', {streamOf: Tick})
      async *ticks(): AsyncGenerator<z.infer<typeof Tick>> {
        yield {n: 1};
      }
    }
    const spec = getControllerSpec(C);
    const op = (
      spec.paths as Record<
        string,
        Record<string, {responses: Record<string, unknown>}>
      >
    )['/ticks'].get;
    const ok = op.responses['200'] as {
      description: string;
      content: Record<string, Record<string, unknown>>;
    };
    expect(ok.description).toBe('Server-sent event stream');
    const media = ok.content['text/event-stream'];
    expect(media['x-itemSchema']).toMatchObject({
      type: 'object',
      properties: {n: {type: 'integer'}},
    });
    // The 3.1-invalid bare keyword must NOT be present.
    expect(media).not.toHaveProperty('itemSchema');
    expect(media).not.toHaveProperty('schema');
  });

  it('rejects streamOf combined with response at decoration time', () => {
    expect(() => {
      class C {
        @get('/bad', {streamOf: Tick, response: Tick})
        async *bad(): AsyncGenerator<z.infer<typeof Tick>> {
          yield {n: 1};
        }
      }
      void C;
    }).toThrow(/'streamOf' and 'response' are mutually exclusive/);
  });

  it('records format in the route registry (jsonl)', () => {
    @api({basePath: '/s'})
    class C {
      @get('/ticks', {streamOf: Tick, format: 'jsonl'})
      async *ticks(): AsyncGenerator<z.infer<typeof Tick>> {
        yield {n: 1};
      }
    }
    const schemas = lookupRouteSchemas(C.prototype, 'ticks');
    expect(schemas?.format).toBe('jsonl');
    expect(schemas?.streamOf).toBe(Tick);
  });

  it('emits application/jsonl with x-itemSchema for format:jsonl', () => {
    @api({basePath: '/s'})
    class C {
      @get('/ticks', {streamOf: Tick, format: 'jsonl'})
      async *ticks(): AsyncGenerator<z.infer<typeof Tick>> {
        yield {n: 1};
      }
    }
    const spec = getControllerSpec(C);
    const op = (
      spec.paths as Record<
        string,
        Record<string, {responses: Record<string, unknown>}>
      >
    )['/ticks'].get;
    const ok = op.responses['200'] as {
      description: string;
      content: Record<string, Record<string, unknown>>;
    };
    expect(ok.description).toBe('Newline-delimited JSON stream');
    const media = ok.content['application/jsonl'];
    expect(media['x-itemSchema']).toMatchObject({
      type: 'object',
      properties: {n: {type: 'integer'}},
    });
    expect(media).not.toHaveProperty('itemSchema');
    expect(ok.content).not.toHaveProperty('text/event-stream');
  });

  it('defaults to text/event-stream when format is omitted (sse unchanged)', () => {
    @api({basePath: '/s'})
    class C {
      @get('/ticks', {streamOf: Tick})
      async *ticks(): AsyncGenerator<z.infer<typeof Tick>> {
        yield {n: 1};
      }
    }
    const spec = getControllerSpec(C);
    const op = (
      spec.paths as Record<
        string,
        Record<string, {responses: Record<string, unknown>}>
      >
    )['/ticks'].get;
    const ok = op.responses['200'] as {
      content: Record<string, Record<string, unknown>>;
    };
    expect(ok.content).toHaveProperty('text/event-stream');
    expect(ok.content).not.toHaveProperty('application/jsonl');
  });

  it('honors a custom success status for the stream response', () => {
    @api({basePath: '/s'})
    class C {
      @get('/ticks', {streamOf: Tick, status: 207})
      async *ticks(): AsyncGenerator<z.infer<typeof Tick>> {
        yield {n: 1};
      }
    }
    const spec = getControllerSpec(C);
    const op = (
      spec.paths as Record<
        string,
        Record<string, {responses: Record<string, unknown>}>
      >
    )['/ticks'].get;
    expect(op.responses['207']).toBeDefined();
    expect(op.responses['200']).toBeUndefined();
  });
});

describe('OpenAPI 3.2 itemSchema promotion', () => {
  const Tick32 = z.object({n: z.number().int()});

  @api({basePath: '/s32'})
  class C32 {
    @get('/ticks', {streamOf: Tick32})
    async *ticks(): AsyncGenerator<z.infer<typeof Tick32>> {
      yield {n: 1};
    }
  }

  function mediaOf(doc: ReturnType<typeof assembleOpenApiSpec>) {
    const op = (
      doc.paths as Record<
        string,
        Record<string, {responses: Record<string, unknown>}>
      >
    )['/s32/ticks'].get;
    const ok = op.responses['200'] as {
      content: Record<string, Record<string, unknown>>;
    };
    return ok.content['text/event-stream'];
  }

  it('keeps x-itemSchema on 3.1 documents (default)', () => {
    const doc = assembleOpenApiSpec([C32]);
    const media = mediaOf(doc);
    expect(media['x-itemSchema']).toBeDefined();
    expect(media).not.toHaveProperty('itemSchema');
  });

  it('promotes to bare itemSchema when the doc declares 3.2+', () => {
    const doc = assembleOpenApiSpec([C32], {openapi: '3.2.0'});
    const media = mediaOf(doc);
    expect(media.itemSchema).toMatchObject({type: 'object'});
    expect(media).not.toHaveProperty('x-itemSchema');
  });

  it('promotes x-itemSchema on the jsonl media type too', () => {
    @api({basePath: '/s32j'})
    class C32Jsonl {
      @get('/ticks', {streamOf: Tick32, format: 'jsonl'})
      async *ticks(): AsyncGenerator<z.infer<typeof Tick32>> {
        yield {n: 1};
      }
    }
    const doc = assembleOpenApiSpec([C32Jsonl], {openapi: '3.2.0'});
    const op = (
      doc.paths as Record<
        string,
        Record<string, {responses: Record<string, unknown>}>
      >
    )['/s32j/ticks'].get;
    const ok = op.responses['200'] as {
      content: Record<string, Record<string, unknown>>;
    };
    const media = ok.content['application/jsonl'];
    expect(media.itemSchema).toMatchObject({type: 'object'});
    expect(media).not.toHaveProperty('x-itemSchema');
  });
});
