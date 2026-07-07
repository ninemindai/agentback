// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {AgentError} from '@agentback/openapi';
import {argvToBundle} from '../../argv-bundle.js';

// The load-bearing behavior (eng review T1 / outside voice findings 1-2):
// @tool inputs are authored z.number()/z.boolean() for typed JSON, so the
// emitted JSON Schema says {type:'number'}. argv delivers strings. The adapter
// must coerce off the JSON-Schema type, NOT hand raw strings to Zod.
const numberSchema = {
  type: 'object',
  properties: {n: {type: 'number'}},
  required: ['n'],
} as const;

describe('argvToBundle — typed coercion off JSON Schema', () => {
  it('coerces a number-typed flag from its string argv value', () => {
    const out = argvToBundle(['--n', '18'], numberSchema);
    expect(out).toEqual({n: 18});
    expect(typeof out.n).toBe('number');
  });

  it('coerces an integer-typed flag', () => {
    const schema = {type: 'object', properties: {age: {type: 'integer'}}};
    expect(argvToBundle(['--age', '42'], schema)).toEqual({age: 42});
  });

  it('rejects a non-numeric value for a number flag with an AgentError', () => {
    expect(() => argvToBundle(['--n', 'abc'], numberSchema)).toThrow(AgentError);
  });

  it('passes a string flag through unchanged', () => {
    const schema = {type: 'object', properties: {city: {type: 'string'}}};
    expect(argvToBundle(['--city', 'Tokyo'], schema)).toEqual({city: 'Tokyo'});
  });
});

describe('argvToBundle — boolean flags (the --no-flag landmine)', () => {
  const boolSchema = {type: 'object', properties: {verbose: {type: 'boolean'}}};

  it('present boolean flag is true', () => {
    expect(argvToBundle(['--verbose'], boolSchema)).toEqual({verbose: true});
  });

  it('--no-<flag> sets it false (never string-coerced to true)', () => {
    expect(argvToBundle(['--no-verbose'], boolSchema)).toEqual({verbose: false});
  });

  it('absent boolean flag is omitted, so a Zod default/optional applies', () => {
    expect(argvToBundle([], boolSchema)).toEqual({});
  });
});

describe('argvToBundle — arrays via repeated flags', () => {
  it('collects repeated string flags into an array', () => {
    const schema = {
      type: 'object',
      properties: {tag: {type: 'array', items: {type: 'string'}}},
    };
    expect(argvToBundle(['--tag', 'a', '--tag', 'b'], schema)).toEqual({
      tag: ['a', 'b'],
    });
  });

  it('coerces array items by their item type', () => {
    const schema = {
      type: 'object',
      properties: {ids: {type: 'array', items: {type: 'number'}}},
    };
    expect(argvToBundle(['--ids', '1', '--ids', '2'], schema)).toEqual({
      ids: [1, 2],
    });
  });
});

describe('argvToBundle — nullable types and errors', () => {
  it('picks the non-null branch of a nullable type', () => {
    const schema = {
      type: 'object',
      properties: {n: {type: ['number', 'null']}},
    };
    expect(argvToBundle(['--n', '7'], schema)).toEqual({n: 7});
  });

  it('rejects an unknown flag with an AgentError', () => {
    const schema = {type: 'object', properties: {city: {type: 'string'}}};
    expect(() => argvToBundle(['--nope', 'x'], schema)).toThrow(AgentError);
  });

  it('with no schema, the tool takes no validated input (empty bundle, stray flags ignored)', () => {
    // A @tool with no input: schema leaves slot 0 free (MCP semantics). Argv
    // can't derive arity without a schema, so the honest CLI contract is: no
    // flags are meaningful — return an empty bundle rather than guess.
    expect(argvToBundle(['--x', '1'], undefined)).toEqual({});
    expect(argvToBundle([], undefined)).toEqual({});
  });
});
