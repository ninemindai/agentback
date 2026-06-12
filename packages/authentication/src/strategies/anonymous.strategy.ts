// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request} from 'express';
import type {UserProfile} from '@agentback/security';
import {ANONYMOUS_USER, type AuthenticationStrategy} from '../types.js';

/**
 * Fallback strategy that never throws — it marks the request as a known
 * anonymous principal ({@link ANONYMOUS_USER}). Use it for public or
 * optional-auth routes via `@authenticate('anonymous')` so the handler still
 * runs with a `UserProfile` in context instead of a 401.
 */
export class AnonymousAuthenticationStrategy implements AuthenticationStrategy {
  name = 'anonymous';

  async authenticate(_request: Request): Promise<UserProfile | undefined> {
    return ANONYMOUS_USER;
  }
}
