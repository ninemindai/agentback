// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import {serializeError, serializeResult} from '../../serialize.js';

describe('serializeResult', () => {
  it('json emits the bare result (no {ok,data} wrapper)', async () => {
    const s = await serializeResult({tempC: 18}, 'json');
    expect(JSON.parse(s)).toEqual({tempC: 18});
  });

  it('text renders a primitive result raw', async () => {
    expect(await serializeResult('hello', 'text')).toBe('hello\n');
  });

  it('text renders an object as pretty JSON', async () => {
    const s = await serializeResult({a: 1}, 'text');
    expect(JSON.parse(s)).toEqual({a: 1});
  });

  it('toon without the optional peer dep gives an install hint', async () => {
    await expect(serializeResult({a: 1}, 'toon')).rejects.toThrow(
      /@toon-format\/toon/,
    );
  });
});

describe('serializeError', () => {
  it('keeps an AgentError code + message', () => {
    const env = JSON.parse(
      serializeError(
        new AgentError('Provide a city.', {code: ErrorCodes.INVALID_INPUT}),
      ),
    );
    expect(env.code).toBe(ErrorCodes.INVALID_INPUT);
    expect(env.message).toBe('Provide a city.');
  });

  it('redacts a plain Error to a generic 500 (message never leaks)', () => {
    const env = JSON.parse(serializeError(new Error('secret db dsn')));
    expect(env.statusCode).toBe(500);
    expect(JSON.stringify(env)).not.toContain('secret db dsn');
  });
});
