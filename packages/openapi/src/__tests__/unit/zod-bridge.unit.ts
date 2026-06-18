// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {
  attachZodSchema,
  getZodSchema,
  isZodSchema,
  lookupRouteSchemas,
  registerRouteSchemas,
  zodToOpenApiSchema,
} from '../../zod-bridge.js';

describe('zod-bridge', () => {
  describe('isZodSchema', () => {
    it('accepts a Zod schema', () => {
      expect(isZodSchema(z.string())).toBe(true);
      expect(isZodSchema(z.object({foo: z.string()}))).toBe(true);
    });

    it('rejects non-Zod values', () => {
      expect(isZodSchema(undefined)).toBe(false);
      expect(isZodSchema(null)).toBe(false);
      expect(isZodSchema({})).toBe(false);
      expect(isZodSchema('string')).toBe(false);
      expect(isZodSchema({parse: () => {}})).toBe(false); // missing safeParse
    });
  });

  describe('zodToOpenApiSchema', () => {
    it('emits JSON Schema 2020-12 for a primitive', () => {
      const schema = zodToOpenApiSchema(z.string().min(1).max(280));
      expect(schema).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 280,
      });
    });

    it('emits JSON Schema for an object with required properties', () => {
      const schema = zodToOpenApiSchema(
        z.object({name: z.string(), age: z.number().int()}),
      );
      expect(schema).toMatchObject({
        type: 'object',
        required: expect.arrayContaining(['name', 'age']),
        properties: {
          name: {type: 'string'},
          age: {type: 'integer'},
        },
      });
    });

    it('omits optional fields from required[]', () => {
      const schema = zodToOpenApiSchema(
        z.object({name: z.string(), age: z.number().optional()}),
      );
      expect((schema as Record<string, unknown>).required).toEqual(['name']);
    });
  });

  describe('attach/getZodSchema (symbol-key)', () => {
    it('round-trips a schema on an object', () => {
      const target = {};
      const schema = z.string();
      attachZodSchema(target, schema);
      expect(getZodSchema(target)).toBe(schema);
    });

    it('returns undefined for null/non-object targets', () => {
      expect(getZodSchema(null)).toBeUndefined();
      expect(getZodSchema('plain string')).toBeUndefined();
      expect(getZodSchema({})).toBeUndefined();
    });
  });

  describe('route-schema registry', () => {
    class Foo {}
    class Bar {}

    it('registers and retrieves a route schema bundle by class+method', () => {
      const body = z.object({x: z.number()});
      const response = z.object({y: z.string()});
      registerRouteSchemas(Foo.prototype, 'create', {body, response});
      const out = lookupRouteSchemas(Foo.prototype, 'create');
      expect(out?.body).toBe(body);
      expect(out?.response).toBe(response);
    });

    it('returns undefined for unrelated classes/methods', () => {
      registerRouteSchemas(Foo.prototype, 'foo', {});
      expect(lookupRouteSchemas(Foo.prototype, 'other')).toBeUndefined();
      expect(lookupRouteSchemas(Bar.prototype, 'foo')).toBeUndefined();
    });
  });
});
