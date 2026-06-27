// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {Binding, compareByOrder, sortBindingsByPhase} from '../../index.js';

describe('BindingComparator', () => {
  const FINAL = Symbol('final');
  const orderOfPhases = ['log', 'auth', FINAL];
  const phaseTagName = 'phase';
  let bindings: Binding<unknown>[];
  let sortedBindingKeys: string[];

  beforeEach(givenBindings);
  beforeEach(sortBindings);

  it('sorts by phase', () => {
    /**
     * Phases
     * - 'log': logger1, logger2
     * - 'auth': auth1, auth2
     */
    assertOrder('logger1', 'logger2', 'auth1', 'auth2');
  });

  it('sorts by phase - unknown phase comes before known ones', () => {
    /**
     * Phases
     * - 'metrics': metrics // not part of ['log', 'auth']
     * - 'log': logger1
     */
    assertOrder('metrics', 'logger1');
  });

  it('sorts by phase alphabetically without orderOf phase', () => {
    /**
     * Phases
     * - 'metrics': metrics // not part of ['log', 'auth']
     * - 'rateLimit': rateLimit // not part of ['log', 'auth']
     */
    assertOrder('metrics', 'rateLimit');
  });

  it('sorts by binding order without phase tags', () => {
    /**
     * Phases
     * - '': validator1, validator2 // not part of ['log', 'auth']
     * - 'metrics': metrics // not part of ['log', 'auth']
     * - 'log': logger1
     */
    assertOrder('validator1', 'validator2', 'metrics', 'logger1');
  });

  it('sorts by binding order without phase tags (for symbol tags)', () => {
    /**
     * Phases
     * - '': validator1 // not part of ['log', 'auth']
     * - 'metrics': metrics // not part of ['log', 'auth']
     * - 'log': logger1
     * - 'final': Symbol('final')
     */
    assertOrder('validator1', 'metrics', 'logger1', 'final');
  });

  /**
   * The sorted bindings by phase:
   * - '': validator1, validator2 // not part of ['log', 'auth']
   * - 'metrics': metrics // not part of ['log', 'auth']
   * - 'rateLimit': rateLimit // not part of ['log', 'auth']
   * - 'log': logger1, logger2
   * - 'auth': auth1, auth2
   */
  function givenBindings() {
    bindings = [
      Binding.bind('logger1').tag({[phaseTagName]: 'log'}),
      Binding.bind('auth1').tag({[phaseTagName]: 'auth'}),
      Binding.bind('auth2').tag({[phaseTagName]: 'auth'}),
      Binding.bind('logger2').tag({[phaseTagName]: 'log'}),
      Binding.bind('metrics').tag({[phaseTagName]: 'metrics'}),
      Binding.bind('rateLimit').tag({[phaseTagName]: 'rateLimit'}),
      Binding.bind('validator1'),
      Binding.bind('validator2'),
      Binding.bind('final').tag({[phaseTagName]: FINAL}),
    ];
  }

  function sortBindings() {
    sortBindingsByPhase(bindings, phaseTagName, orderOfPhases);
    sortedBindingKeys = bindings.map(b => b.key);
  }

  function assertOrder(...keys: string[]) {
    let prev = -1;
    let prevKey = '';
    for (const key of keys) {
      const current = sortedBindingKeys.indexOf(key);
      expect(current).toBeGreaterThan(prev);
      prev = current;
      prevKey = key;
    }
  }
});

describe('compareByOrder', () => {
  it('honors order', () => {
    expect(compareByOrder('a', 'b', ['b', 'a'])).toBeGreaterThan(0);
  });

  it('value not included in order comes first', () => {
    expect(compareByOrder('a', 'c', ['a', 'b'])).toBeGreaterThan(0);
  });

  it('values not included are compared alphabetically', () => {
    expect(compareByOrder('a', 'c', [])).toBeLessThan(0);
  });

  it('null/undefined/"" values are treated as ""', () => {
    expect(compareByOrder('', 'c')).toBeLessThan(0);
    expect(compareByOrder(null, 'c')).toBeLessThan(0);
    expect(compareByOrder(undefined, 'c')).toBeLessThan(0);
  });

  it('returns 0 for equal values', () => {
    expect(compareByOrder('c', 'c')).toBe(0);
    expect(compareByOrder(null, '')).toBe(0);
    expect(compareByOrder('', undefined)).toBe(0);
  });

  it('allows symbols', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(compareByOrder(a, b)).toBeLessThan(0);
    expect(compareByOrder(a, b, [b, a])).toBeGreaterThan(0);
    expect(compareByOrder(a, 'b', [b, a])).toBeGreaterThan(0);
  });

  it('list symbols before strings', () => {
    const a = 'a';
    const b = Symbol('a');
    expect(compareByOrder(a, b)).toBeGreaterThan(0);
    expect(compareByOrder(b, a)).toBeLessThan(0);
  });

  it('compare symbols by description', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(compareByOrder(a, b)).toBeLessThan(0);
    expect(compareByOrder(b, a)).toBeGreaterThan(0);
  });
});
