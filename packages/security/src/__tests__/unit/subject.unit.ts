// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {
  ClientApplication,
  DefaultSubject,
  securityId,
  UserProfile,
} from '../../index.js';
import {Permission} from '../../types.js';

describe('DefaultSubject', () => {
  const subject = new DefaultSubject();
  it('adds users', () => {
    const user: UserProfile = {[securityId]: 'user-001', type: 'USER'};
    subject.addUser(user);
    expect(subject.user).toEqual(user);
  });

  it('adds application', () => {
    const app: ClientApplication = {
      [securityId]: 'app-001',
      type: 'APPLICATION',
    };
    subject.addApplication(app);
    expect(subject.getPrincipal('APPLICATION')).toBe(app);
  });

  it('adds authority', () => {
    const perm1 = new Permission();
    perm1.action = 'get';
    perm1.resourceType = 'User';
    const perm2 = new Permission();
    perm2.action = 'update';
    perm2.resourceType = 'User';
    subject.addAuthority(perm1, perm2);
    expect(subject.authorities).toContainEqual(perm1);
    expect(subject.authorities).toContainEqual(perm2);
  });
  it('adds credential', () => {
    const cred = {usr: 'auser', pass: 'mypass'};
    subject.addCredential(cred);
    expect(subject.credentials).toContainEqual(cred);
  });
});
