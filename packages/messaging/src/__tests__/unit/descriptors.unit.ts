// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {defineQueue, defineTopic} from '../../descriptors.js';

describe('descriptors', () => {
  it('defineQueue carries name, schema, and queue kind', () => {
    const schema = z.object({n: z.number()});
    const q = defineQueue('test.jobs', schema);
    expect(q.name).toBe('test.jobs');
    expect(q.schema).toBe(schema);
    expect(q.__kind).toBe('queue');
  });

  it('defineTopic carries name, schema, and topic kind', () => {
    const schema = z.object({event: z.string()});
    const t = defineTopic('test.events', schema);
    expect(t.name).toBe('test.events');
    expect(t.schema).toBe(schema);
    expect(t.__kind).toBe('topic');
  });

  it('queue schema validates payloads', () => {
    const q = defineQueue('test.jobs', z.object({n: z.number()}));
    expect(() => q.schema.parse({n: 'no'})).toThrow();
    expect(q.schema.parse({n: 1})).toEqual({n: 1});
  });

  it('topic schema validates events', () => {
    const t = defineTopic('test.events', z.object({event: z.string()}));
    expect(() => t.schema.parse({event: 42})).toThrow();
    expect(t.schema.parse({event: 'click'})).toEqual({event: 'click'});
  });
});
