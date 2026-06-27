// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Context, inject} from '@agentback/context';
import type {Fetch} from '@agentback/common';
import {CoreBindings} from '../../keys.js';

// A service in the shape every external-API service takes: it depends on the
// injectable fetch seam rather than reaching for global `fetch`, so tests can
// feed it canned responses with no network.
class Weatherish {
  constructor(
    @inject(CoreBindings.FETCH, {optional: true})
    private readonly fetchJson: Fetch = globalThis.fetch,
  ) {}

  async status(url: string): Promise<number> {
    const res = await this.fetchJson(url);
    return res.status;
  }
}

describe('CoreBindings.FETCH', () => {
  it('injects a bound fetch stub into a service', async () => {
    const ctx = new Context('test');
    const seen: string[] = [];
    const stub: Fetch = async input => {
      seen.push(String(input));
      return new Response(null, {status: 418});
    };
    ctx.bind(CoreBindings.FETCH).to(stub);
    ctx.bind('services.Weatherish').toClass(Weatherish);

    const svc = await ctx.get<Weatherish>('services.Weatherish');
    expect(await svc.status('https://example.test/api')).toBe(418);
    expect(seen).toEqual(['https://example.test/api']);
  });

  it('falls back to globalThis.fetch when the binding is absent', async () => {
    const ctx = new Context('test');
    ctx.bind('services.Weatherish').toClass(Weatherish);

    const svc = await ctx.get<Weatherish>('services.Weatherish');
    expect(svc).toBeInstanceOf(Weatherish);
  });
});
