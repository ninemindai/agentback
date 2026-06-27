// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MetadataAccessor} from '@agentback/metadata';
import {BindingKey} from '@agentback/context';
import type {
  ApiKeyVerifier,
  AuthenticationMetadata,
  AuthenticationStrategy,
  ClientCredentialsVerifier,
} from './types.js';

export namespace AuthenticationBindings {
  /**
   * Extension-point tag: bind strategies with this tag so the interceptor
   * can discover them by `findByTag(AUTH_STRATEGY)`.
   */
  export const AUTH_STRATEGY = 'authentication.strategy';

  /** Convenience binding for the resolved strategy instance (per request). */
  export const CURRENT_STRATEGY = BindingKey.create<AuthenticationStrategy>(
    'authentication.currentStrategy',
  );
}

/**
 * Binding key for the {@link ApiKeyVerifier} used by
 * {@link ApiKeyAuthenticationStrategy}. Bind your validation function here.
 */
export const API_KEY_VERIFIER = BindingKey.create<ApiKeyVerifier>(
  'authentication.apiKeyVerifier',
);

/**
 * Binding key for the {@link ClientCredentialsVerifier} used by
 * {@link ClientCredentialsAuthenticationStrategy}.
 */
export const CLIENT_CREDENTIALS_VERIFIER =
  BindingKey.create<ClientCredentialsVerifier>(
    'authentication.clientCredentialsVerifier',
  );

/** Reflection key for the @authenticate decorator's class/method metadata. */
export namespace AuthenticationKeys {
  export const METADATA = MetadataAccessor.create<
    AuthenticationMetadata,
    MethodDecorator
  >('authentication:method');
  export const CLASS_METADATA = MetadataAccessor.create<
    AuthenticationMetadata,
    ClassDecorator
  >('authentication:class');
}
