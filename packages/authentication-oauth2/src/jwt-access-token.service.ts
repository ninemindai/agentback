// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {KeyObject} from 'node:crypto';
import {inject} from '@agentback/context';
import {
  createRemoteJWKSet,
  jwtVerify,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import createError from 'http-errors';
import {OAuth2JwtBindings} from './keys.js';
import type {OAuth2JwtConfig} from './types.js';

/** Anything jose's `jwtVerify` accepts as its key argument. */
export type JwtKeyInput = CryptoKey | KeyObject | Uint8Array | JWTVerifyGetKey;

/**
 * Verifies OAuth2 JWT access tokens (RFC 9068) issued by a third-party
 * authorization server. Unlike opaque tokens, a JWT carries its own signature,
 * so this validates locally against the AS's published signing keys — no
 * per-request network call — and enforces `iss` / `aud` / `exp`.
 *
 * Supply either a key resolver (bound under {@link OAuth2JwtBindings.KEY_RESOLVER})
 * or a `jwksUri` in config, from which a cached remote JWKS is built. A token
 * that fails verification for any reason maps to a 401.
 */
export class JwtAccessTokenService {
  private readonly key: JwtKeyInput;

  constructor(
    @inject(OAuth2JwtBindings.CONFIG) private config: OAuth2JwtConfig,
    @inject(OAuth2JwtBindings.KEY_RESOLVER, {optional: true})
    keyInput?: JwtKeyInput,
  ) {
    if (keyInput) {
      this.key = keyInput;
    } else if (config.jwksUri) {
      this.key = createRemoteJWKSet(new URL(config.jwksUri));
    } else {
      throw new Error(
        'JwtAccessTokenService requires a key resolver or config.jwksUri',
      );
    }
  }

  async verify(token: string): Promise<JWTPayload> {
    const options = {
      issuer: this.config.issuer,
      audience: this.config.audience,
      clockTolerance: this.config.clockToleranceSec,
    };
    try {
      const key = this.key;
      const {payload} =
        typeof key === 'function'
          ? await jwtVerify(token, key, options)
          : await jwtVerify(token, key, options);
      return payload;
    } catch (err) {
      throw createError(401, `Invalid access token: ${(err as Error).message}`);
    }
  }
}
