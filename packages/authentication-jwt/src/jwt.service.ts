// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {inject} from '@agentback/context';
import {securityId, UserProfile} from '@agentback/security';
import createError from 'http-errors';
import jwt, {Secret, SignOptions} from 'jsonwebtoken';
import {JWTBindings} from './keys.js';

/**
 * Sign/verify JSON Web Tokens. User-shape agnostic — the `UserProfile`
 * fields we round-trip are the ones present (id, name, email, etc).
 */
export class JWTService {
  constructor(
    @inject(JWTBindings.SECRET) private secret: Secret,
    @inject(JWTBindings.EXPIRES_IN) private expiresIn: string | number,
  ) {}

  async verifyToken(token: string): Promise<UserProfile> {
    if (!token) {
      throw createError(401, "Error verifying token: 'token' is null");
    }
    try {
      const decoded = jwt.verify(token, this.secret) as Record<string, unknown>;
      const id = String(
        decoded.id ?? (decoded as Record<symbol, unknown>)[securityId] ?? '',
      );
      const profile: UserProfile = {
        [securityId]: id,
        name: (decoded.name as string) ?? '',
        ...decoded,
      };
      // Strip JWT framing claims from the public profile
      delete (profile as Record<string, unknown>).iat;
      delete (profile as Record<string, unknown>).exp;
      return profile;
    } catch (err) {
      throw createError(
        401,
        `Error verifying token: ${(err as Error).message}`,
      );
    }
  }

  async generateToken(userProfile: UserProfile): Promise<string> {
    if (!userProfile) {
      throw createError(401, 'Error generating token: userProfile is null');
    }
    // Copy every enumerable field on the profile (roles, scopes, email, etc.)
    // and put the securityId under `id`. JWT framing claims (iat/exp) are
    // added by jsonwebtoken itself; we strip them on verify.
    const payload: Record<string, unknown> = {
      ...(userProfile as unknown as Record<string, unknown>),
      id: userProfile[securityId],
    };
    try {
      return jwt.sign(payload, this.secret, {
        expiresIn: this.expiresIn as SignOptions['expiresIn'],
      });
    } catch (err) {
      throw createError(401, `Error encoding token: ${(err as Error).message}`);
    }
  }
}
