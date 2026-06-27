// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {OAuth2IntrospectionService} from './introspection.service.js';
import type {
  JwtAccessTokenService,
  JwtKeyInput,
} from './jwt-access-token.service.js';
import type {
  FetchLike,
  OAuth2IntrospectionConfig,
  OAuth2JwtConfig,
} from './types.js';

export namespace OAuth2Bindings {
  /** Introspection endpoint + resource-server credentials. */
  export const CONFIG = BindingKey.create<OAuth2IntrospectionConfig>(
    'oauth2.introspection.config',
  );
  /** The resolved {@link OAuth2IntrospectionService}. */
  export const SERVICE = BindingKey.create<OAuth2IntrospectionService>(
    'oauth2.introspection.service',
  );
  /**
   * Optional `fetch` override. Defaults to the global `fetch`; bind a stub to
   * exercise the service without a network.
   */
  export const FETCH = BindingKey.create<FetchLike>(
    'oauth2.introspection.fetch',
  );
}

export namespace OAuth2JwtBindings {
  /** Issuer/audience/JWKS config for the JWT access-token strategy. */
  export const CONFIG = BindingKey.create<OAuth2JwtConfig>('oauth2.jwt.config');
  /** The resolved {@link JwtAccessTokenService}. */
  export const SERVICE =
    BindingKey.create<JwtAccessTokenService>('oauth2.jwt.service');
  /**
   * Optional signing-key resolver (a jose key or `JWTVerifyGetKey`). When
   * absent the service builds a remote JWKS from {@link OAuth2JwtConfig.jwksUri}.
   * Bind a local key to verify without a network (tests, embedded keys).
   */
  export const KEY_RESOLVER = BindingKey.create<JwtKeyInput>(
    'oauth2.jwt.keyResolver',
  );
}
