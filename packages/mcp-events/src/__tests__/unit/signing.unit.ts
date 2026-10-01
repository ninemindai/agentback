// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {isWebhookSecret} from '@agentback/mcp';
import {
  constantTimeEqual,
  generateWebhookSecret,
  signatureFor,
  signWebhook,
  verifyWebhook,
} from '../../signing.js';

// The reference vector from the Standard Webhooks spec (also Svix's test
// suite) — signing must interoperate with off-the-shelf verifiers.
const REF = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('Standard Webhooks signing', () => {
  it('matches the spec reference vector', async () => {
    expect(
      await signatureFor(REF.secret, REF.id, REF.timestamp, REF.body),
    ).toBe(REF.signature);
  });

  it('dual-signs during rotation; a receiver holding either secret verifies', async () => {
    const oldSecret = generateWebhookSecret();
    const newSecret = generateWebhookSecret();
    const ts = 1_700_000_000;
    const header = await signWebhook([newSecret, oldSecret], 'evt_1', ts, 'b');
    expect(header.split(' ')).toHaveLength(2);
    const headers = {
      'webhook-id': 'evt_1',
      'webhook-timestamp': String(ts),
      'webhook-signature': header,
    };
    const now = () => ts * 1000;
    expect(await verifyWebhook(oldSecret, headers, 'b', {now})).toBe(true);
    expect(await verifyWebhook(newSecret, headers, 'b', {now})).toBe(true);
    expect(
      await verifyWebhook(generateWebhookSecret(), headers, 'b', {now}),
    ).toBe(false);
  });

  it('rejects a tampered body, a changed id, and a stale timestamp', async () => {
    const secret = generateWebhookSecret();
    const ts = 1_700_000_000;
    const headers = {
      'webhook-id': 'evt_1',
      'webhook-timestamp': String(ts),
      'webhook-signature': await signWebhook([secret], 'evt_1', ts, '{"a":1}'),
    };
    const now = () => ts * 1000;
    expect(await verifyWebhook(secret, headers, '{"a":1}', {now})).toBe(true);
    expect(await verifyWebhook(secret, headers, '{"a":2}', {now})).toBe(false);
    expect(
      await verifyWebhook(
        secret,
        {...headers, 'webhook-id': 'evt_2'},
        '{"a":1}',
        {now},
      ),
    ).toBe(false);
    expect(
      await verifyWebhook(secret, headers, '{"a":1}', {
        now: () => (ts + 301) * 1000,
      }),
    ).toBe(false);
  });

  it('generates valid whsec_ secrets and refuses bad sizes', () => {
    expect(isWebhookSecret(generateWebhookSecret())).toBe(true);
    expect(isWebhookSecret(generateWebhookSecret(24))).toBe(true);
    expect(isWebhookSecret(generateWebhookSecret(64))).toBe(true);
    expect(() => generateWebhookSecret(16)).toThrow(/24–64 bytes/);
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });

  it('compares in constant time over equal lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
