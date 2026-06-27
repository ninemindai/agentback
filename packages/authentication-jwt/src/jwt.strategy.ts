// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ContextTags, injectable} from '@agentback/context';
import {inject} from '@agentback/context';
import type {
  AuthRequest,
  AuthenticationStrategy,
} from '@agentback/authentication';
import {AuthenticationBindings} from '@agentback/authentication';
import type {UserProfile} from '@agentback/security';
import createError from 'http-errors';
import {JWTBindings} from './keys.js';
import {JWTService} from './jwt.service.js';

@injectable({
  tags: {
    [ContextTags.NAME]: 'jwt.strategy',
    [AuthenticationBindings.AUTH_STRATEGY]: true,
  },
})
export class JWTAuthenticationStrategy implements AuthenticationStrategy {
  name = 'jwt';

  constructor(@inject(JWTBindings.SERVICE) private tokenService: JWTService) {}

  async authenticate(request: AuthRequest): Promise<UserProfile | undefined> {
    const token = this.extractToken(request);
    return this.tokenService.verifyToken(token);
  }

  private extractToken(request: AuthRequest): string {
    const header = request.headerValue('authorization');
    if (!header) {
      throw createError(401, 'Authorization header not found.');
    }
    if (!header.startsWith('Bearer ')) {
      throw createError(401, "Authorization header is not of type 'Bearer'.");
    }
    const parts = header.split(' ');
    if (parts.length !== 2 || !parts[1]) {
      throw createError(
        401,
        "Authorization header value must be 'Bearer xx.yy.zz'.",
      );
    }
    return parts[1];
  }
}
