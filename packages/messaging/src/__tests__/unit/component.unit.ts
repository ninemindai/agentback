// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Context} from '@agentback/core';
import {InMemoryMessagingComponent} from '../../component.js';
import {EVENT_BUS, JOB_QUEUE, QUEUE_ADMIN, SCHEDULER} from '../../keys.js';

describe('InMemoryMessagingComponent', () => {
  it('binds all four messaging ports', () => {
    const ctx = new Context('app');
    const component = new InMemoryMessagingComponent();
    for (const b of component.bindings ?? []) ctx.add(b);

    expect(ctx.getSync(JOB_QUEUE)).toBeDefined();
    expect(ctx.getSync(EVENT_BUS)).toBeDefined();
    expect(ctx.getSync(QUEUE_ADMIN)).toBeDefined();
    expect(ctx.getSync(SCHEDULER)).toBeDefined();
  });
});
