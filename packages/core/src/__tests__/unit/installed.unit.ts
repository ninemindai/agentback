// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Context} from '@agentback/context';
import {revertOwned, unbindOwned} from '../../installed.js';

describe('revertOwned', () => {
  it('unbinds and restores the displaced binding when still ours', () => {
    const ctx = new Context();
    const prior = ctx.bind('k').to('prior');
    const ours = ctx.bind('k').to('ours');

    expect(revertOwned(ctx, ours, prior)).toBe(true);
    expect(ctx.getSync('k')).toBe('prior');
  });

  it('unbinds with no restore when there was no displaced binding', () => {
    const ctx = new Context();
    const ours = ctx.bind('k').to('ours');

    expect(revertOwned(ctx, ours)).toBe(true);
    expect(ctx.isBound('k')).toBe(false);
  });

  it('touches NOTHING when a third party rebound the key', () => {
    const ctx = new Context();
    const prior = ctx.bind('k').to('prior');
    const ours = ctx.bind('k').to('ours');
    ctx.bind('k').to('third-party');

    expect(revertOwned(ctx, ours, prior)).toBe(false);
    // The critical assertion: the restore must NOT fire either. A guarded
    // unbind paired with an unguarded restore reintroduces the exact bug the
    // guard exists to prevent.
    expect(ctx.getSync('k')).toBe('third-party');
  });

  it('unbindOwned keeps its no-restore behavior', () => {
    const ctx = new Context();
    const ours = ctx.bind('k').to('ours');
    unbindOwned(ctx, ours);
    expect(ctx.isBound('k')).toBe(false);
  });
});
