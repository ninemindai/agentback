// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {AgentError, ErrorCodes, buildErrorEnvelope} from '../../agent-error.js';

describe('AgentError', () => {
  it('preserves its message through the envelope (client error)', () => {
    const err = new AgentError('Provide a city or coordinates.', {
      code: ErrorCodes.INVALID_INPUT,
      status: 400,
    });
    const envelope = buildErrorEnvelope(err);
    expect(envelope.statusCode).toBe(400);
    expect(envelope.code).toBe('invalid_input');
    expect(envelope.message).toBe('Provide a city or coordinates.');
    expect(envelope.retryable).toBe(true);
  });

  it('defaults to a 400 client error', () => {
    const err = new AgentError('bad input');
    expect(err.statusCode).toBe(400);
    const envelope = buildErrorEnvelope(err);
    expect(envelope.message).toBe('bad input');
    expect(envelope.statusCode).toBe(400);
  });

  it('carries issues, hint, and schema into the envelope', () => {
    const err = new AgentError('invalid', {
      code: ErrorCodes.INVALID_INPUT,
      issues: [{path: ['city'], message: 'required'} as never],
      hint: 'pass a city',
      schema: {type: 'object'},
    });
    const envelope = buildErrorEnvelope(err);
    expect(envelope.issues).toHaveLength(1);
    expect(envelope.hint).toBe('pass a city');
    expect(envelope.schema).toEqual({type: 'object'});
  });

  it('surfaces an intentional 5xx message (publicMessage)', () => {
    const err = new AgentError('upstream weather API is down', {status: 503});
    const envelope = buildErrorEnvelope(err);
    expect(envelope.statusCode).toBe(503);
    // 5xx normally redacts; an AgentError message is explicitly public.
    expect(envelope.message).toBe('upstream weather API is down');
  });

  it('is an Error subclass with the right name', () => {
    const err = new AgentError('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentError');
  });
});
