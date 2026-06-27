// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {Permission} from '../../index.js';
import {securityId} from '../../types.js';

describe('Permission', () => {
  it('generates security id', () => {
    const permission = new Permission();
    permission.action = 'create';
    permission.resourceType = 'order';
    expect(permission[securityId]).toEqual('order:create');
  });

  it('generates security id with resource property', () => {
    const permission = new Permission();
    permission.action = 'read';
    permission.resourceType = 'user';
    permission.resourceProperty = 'email';
    expect(permission[securityId]).toEqual('user.email:read');
  });

  it('generates security id with resource id', () => {
    const permission = new Permission();
    permission.action = 'delete';
    permission.resourceType = 'order';
    permission.resourceId = '001';
    expect(permission[securityId]).toEqual('order:delete:001');
  });
});
