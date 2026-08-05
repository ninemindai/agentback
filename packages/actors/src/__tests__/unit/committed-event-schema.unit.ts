// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {CommittedActorEventSchema} from '../../types.js';

describe('CommittedActorEventSchema', () => {
  const base = {
    actor: {type: 'cart', id: 'ada'},
    seq: 0,
    requestId: 'r1',
    event: {type: 'CheckedOut'},
  };

  it('rejects an event object missing seatKeyId', () => {
    const result = CommittedActorEventSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it("accepts the '' sentinel (no seat layer bound)", () => {
    const result = CommittedActorEventSchema.safeParse({
      ...base,
      seatKeyId: '',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a real seat key id', () => {
    const result = CommittedActorEventSchema.safeParse({
      ...base,
      seatKeyId: 'seat-key-abc',
    });
    expect(result.success).toBe(true);
  });
});
