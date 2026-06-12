// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeEach} from 'vitest';
import {securityId, UserProfile} from '@agentback/security';
import {JWTService} from '../../jwt.service.js';

describe('JWTService', () => {
  let service: JWTService;

  beforeEach(() => {
    service = new JWTService('test-secret', '1h');
  });

  describe('generateToken', () => {
    it('round-trips a UserProfile through verify', async () => {
      const profile: UserProfile = {
        [securityId]: 'alice',
        name: 'alice',
      };
      const token = await service.generateToken(profile);
      const verified = await service.verifyToken(token);
      expect(verified[securityId]).toBe('alice');
      expect(verified.name).toBe('alice');
    });

    it('preserves custom claims like roles and scopes', async () => {
      const profile = {
        [securityId]: 'eve',
        name: 'eve',
        roles: ['admin', 'editor'],
        scopes: ['widgets:write', 'widgets:read'],
      } as UserProfile;
      const token = await service.generateToken(profile);
      const verified = (await service.verifyToken(token)) as UserProfile & {
        roles?: string[];
        scopes?: string[];
      };
      expect(verified.roles).toEqual(['admin', 'editor']);
      expect(verified.scopes).toEqual(['widgets:write', 'widgets:read']);
    });

    it('strips iat/exp framing claims from the verified profile', async () => {
      const token = await service.generateToken({
        [securityId]: 'bob',
        name: 'bob',
      });
      const verified = (await service.verifyToken(token)) as Record<
        string,
        unknown
      >;
      expect(verified.iat).toBeUndefined();
      expect(verified.exp).toBeUndefined();
    });
  });

  describe('verifyToken', () => {
    it('throws 401 on empty token', async () => {
      await expect(service.verifyToken('')).rejects.toThrow(/null/);
    });

    it('throws 401 on tampered token', async () => {
      const token = await service.generateToken({
        [securityId]: 'alice',
        name: 'alice',
      });
      const tampered = token.slice(0, -3) + 'xxx';
      await expect(service.verifyToken(tampered)).rejects.toThrow(
        /Error verifying token/,
      );
    });

    it('throws 401 when secret does not match', async () => {
      const token = await service.generateToken({
        [securityId]: 'alice',
        name: 'alice',
      });
      const other = new JWTService('different-secret', '1h');
      await expect(other.verifyToken(token)).rejects.toThrow();
    });
  });
});
