// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get, post} from '../../decorators/index.js';
import {getControllerSpec} from '../../controller-spec.js';
import {
  isOptionalSchema,
  registerJSONSchemaConverter,
  schemaPropertyInfo,
  schemaToOpenApiSchema,
  standardParse,
} from '../../zod-bridge.js';
import type {StandardSchemaV1} from '../../standard-schema.js';

/**
 * A minimal Standard Schema V1 vendor for tests — validates an object whose
 * declared keys must be strings. Mimics a Valibot-style library: validates
 * fine, but has no native JSON Schema emission.
 */
function fakeObjectSchema(
  keys: string[],
  vendor = 'fake',
): StandardSchemaV1<unknown, Record<string, string>> {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate(value: unknown) {
        if (value == null || typeof value !== 'object') {
          return {issues: [{message: 'expected an object'}]};
        }
        const out: Record<string, string> = {};
        for (const k of keys) {
          const v = (value as Record<string, unknown>)[k];
          if (typeof v !== 'string') {
            return {
              issues: [{message: `expected string at ${k}`, path: [k]}],
            };
          }
          out[k] = v;
        }
        return {value: out};
      },
    },
  };
}

/** Register emission for the 'fake' vendor (object of strings). */
registerJSONSchemaConverter('fake', schema => {
  const keys =
    (schema as unknown as {__keys?: string[]}).__keys ??
    // For schemas created by fakeObjectSchema below, attach keys at creation.
    [];
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map(k => [k, {type: 'string'}])),
    required: keys,
  };
});

function fakeWithEmission(keys: string[]) {
  const schema = fakeObjectSchema(keys);
  (schema as unknown as {__keys: string[]}).__keys = keys;
  return schema;
}

describe('standardParse', () => {
  it('zod fast-path preserves rich issues', () => {
    const r = standardParse(z.object({a: z.number()}), {a: 'x'});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.issues[0].path).toEqual(['a']);
      expect(r.issues[0].code).toBeDefined();
    }
  });

  it('validates via ~standard for non-Zod vendors', () => {
    const schema = fakeObjectSchema(['name']);
    expect(standardParse(schema, {name: 'x'})).toEqual({
      success: true,
      data: {name: 'x'},
    });
    const bad = standardParse(schema, {name: 42});
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.issues[0].path).toEqual(['name']);
  });

  it('rejects async validation with a clear error', () => {
    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'slow',
        validate: async v => ({value: v}),
      },
    };
    expect(() => standardParse(schema, {})).toThrow(/Async validation/);
  });
});

describe('schemaToOpenApiSchema', () => {
  it('uses a registered vendor converter', () => {
    const json = schemaToOpenApiSchema(fakeWithEmission(['a', 'b']));
    expect(json).toMatchObject({
      type: 'object',
      required: ['a', 'b'],
    });
  });

  it('uses a native toJsonSchema capability when present (ArkType-style)', () => {
    const schema = Object.assign(fakeObjectSchema(['x'], 'arkish'), {
      toJsonSchema: () => ({type: 'object' as const, description: 'native'}),
    });
    expect(schemaToOpenApiSchema(schema)).toEqual({
      type: 'object',
      description: 'native',
    });
  });

  it('throws (startup-visible) for converter-less vendors', () => {
    expect(() =>
      schemaToOpenApiSchema(fakeObjectSchema(['x'], 'mystery')),
    ).toThrow(/registerJSONSchemaConverter\('mystery'/);
  });
});

describe('schemaPropertyInfo + spec emission for non-Zod schemas', () => {
  it('derives keys/required from emitted JSON Schema', () => {
    const info = schemaPropertyInfo(fakeWithEmission(['id', 'tag']));
    expect(info.keys.sort()).toEqual(['id', 'tag']);
    expect([...info.required].sort()).toEqual(['id', 'tag']);
  });

  it('isOptionalSchema is false for required object schemas', () => {
    expect(isOptionalSchema(fakeWithEmission(['id']))).toBe(false);
    expect(isOptionalSchema(z.object({}).optional())).toBe(true);
  });

  it('a controller using a fake-vendor schema emits parameters + body', () => {
    const PathS = fakeWithEmission(['id']);
    const BodyS = fakeWithEmission(['note']);

    @api({basePath: '/f'})
    class FakeController {
      @get('/items/{id}', {path: PathS})
      async item(input: {path: Record<string, string>}) {
        return input.path;
      }

      @post('/items', {body: BodyS})
      async create(input: {body: Record<string, string>}) {
        return input.body;
      }
    }

    const spec = getControllerSpec(FakeController);
    const paths = spec.paths as Record<
      string,
      Record<string, {parameters?: unknown[]; requestBody?: unknown}>
    >;
    expect(paths['/items/{id}'].get.parameters).toEqual([
      {name: 'id', in: 'path', required: true, schema: {type: 'string'}},
    ]);
    expect(paths['/items'].post.requestBody).toMatchObject({
      required: true,
      content: {'application/json': {schema: {type: 'object'}}},
    });
  });
});
