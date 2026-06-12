// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {inject} from '@agentback/context';
import type {Request} from 'express';
import {CLIENT_CREDENTIALS_VERIFIER} from '../keys.js';
import type {
  AuthenticationResult,
  AuthenticationStrategy,
  ClientCredentialsVerifier,
} from '../types.js';

/** Read `client_id`/`client_secret` from headers or an `Authorization: Basic`. */
function parseClientCredentials(request: Request): {
  clientId?: string;
  clientSecret?: string;
} {
  const headers = request.headers;
  const headerId = headers['client_id'];
  const headerSecret = headers['client_secret'];
  let clientId = typeof headerId === 'string' ? headerId : undefined;
  let clientSecret =
    typeof headerSecret === 'string' ? headerSecret : undefined;

  if (!clientId || !clientSecret) {
    const auth = headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep >= 0) {
        clientId = decoded.slice(0, sep);
        clientSecret = decoded.slice(sep + 1);
      }
    }
  }
  return {clientId, clientSecret};
}

/**
 * OAuth2-style client-credentials strategy. Authenticates the calling
 * application (not a user) from `client_id`/`client_secret` headers or HTTP
 * Basic auth, and resolves them to a {@link ClientApplication} via an injected
 * {@link ClientCredentialsVerifier} ({@link CLIENT_CREDENTIALS_VERIFIER}).
 *
 * Returns an {@link AuthenticationResult} whose `user` and `clientApplication`
 * are the resolved app — so the principal is the application and
 * `@agentback/authorization`'s scope governance (`clientAppScopeVoter`)
 * can read it from the request context.
 */
export class ClientCredentialsAuthenticationStrategy implements AuthenticationStrategy {
  name = 'client-credentials';

  constructor(
    @inject(CLIENT_CREDENTIALS_VERIFIER, {optional: true})
    private verify?: ClientCredentialsVerifier,
  ) {}

  async authenticate(request: Request): Promise<AuthenticationResult> {
    const {clientId, clientSecret} = parseClientCredentials(request);
    if (!clientId || !clientSecret) {
      throw new Error('Missing client credentials');
    }
    if (!this.verify) {
      throw new Error(
        'No client-credentials verifier bound (bind CLIENT_CREDENTIALS_VERIFIER)',
      );
    }
    const app = await this.verify(clientId, clientSecret, request);
    if (!app) throw new Error('Invalid client credentials');
    return {user: app, clientApplication: app};
  }
}
