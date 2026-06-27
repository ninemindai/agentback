// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {Principal, securityId, TypedPrincipal} from '../../index.js';

describe('typed principal', () => {
  it('returns the security id', () => {
    const principal: Principal = {[securityId]: 'auser'};
    const typedPrincipal = new TypedPrincipal(principal, 'USER');
    expect(typedPrincipal[securityId]).toEqual('USER:auser');
  });
});
