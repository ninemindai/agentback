// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeEach} from 'vitest';
import type {FocusDescriptor} from '../../client/focus.js';
import {
  publishFocus,
  subscribeFocus,
  getFocus,
} from '../../client/focus.js';

describe('focus bus', () => {
  beforeEach(() => {
    // Reset module-level state between tests by publishing null.
    publishFocus(null);
  });

  it('delivers a descriptor to a subscriber', () => {
    const received: Array<FocusDescriptor | null> = [];
    const unsub = subscribeFocus(d => received.push(d));

    publishFocus({kind: 'schema-entity', id: 'UserSchema', label: 'User'});
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      kind: 'schema-entity',
      id: 'UserSchema',
      label: 'User',
    });
  });

  it('delivers null to subscribers on deselect', () => {
    const received: Array<FocusDescriptor | null> = [];
    const unsub = subscribeFocus(d => received.push(d));

    publishFocus({kind: 'binding', id: 'services.MyService'});
    publishFocus(null);
    unsub();

    expect(received).toEqual([{kind: 'binding', id: 'services.MyService'}, null]);
  });

  it('getFocus returns the current descriptor', () => {
    publishFocus({kind: 'route', id: 'GET /users', label: 'List users'});
    expect(getFocus()).toEqual({kind: 'route', id: 'GET /users', label: 'List users'});
  });

  it('getFocus returns null after publishFocus(null)', () => {
    publishFocus({kind: 'tool', id: 'forecast'});
    publishFocus(null);
    expect(getFocus()).toBeNull();
  });

  it('unsubscribe stops delivery', () => {
    const received: Array<FocusDescriptor | null> = [];
    const unsub = subscribeFocus(d => received.push(d));

    publishFocus({kind: 'schema-entity', id: 'A'});
    unsub();
    publishFocus({kind: 'schema-entity', id: 'B'});

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('A');
  });

  it('multiple subscribers each receive the event', () => {
    const a: Array<FocusDescriptor | null> = [];
    const b: Array<FocusDescriptor | null> = [];
    const unsubA = subscribeFocus(d => a.push(d));
    const unsubB = subscribeFocus(d => b.push(d));

    publishFocus({kind: 'binding', id: 'x'});
    unsubA();
    unsubB();

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
