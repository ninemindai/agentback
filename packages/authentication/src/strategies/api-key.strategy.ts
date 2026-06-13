// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {inject} from '@agentback/context';
import type {Request} from 'express';
import type {UserProfile} from '@agentback/security';
import {API_KEY_VERIFIER} from '../keys.js';
import type {ApiKeyVerifier, AuthenticationStrategy} from '../types.js';

/**
 * Generic API-key strategy. Reads the key from the `x-api-key` header (or the
 * `apiKey` query parameter) and delegates validation to an injected
 * {@link ApiKeyVerifier} bound under {@link API_KEY_VERIFIER}. Throwing
 * converts to a 401 in the REST server.
 *
 * @example
 *   app.bind(API_KEY_VERIFIER).to(async key =>
 *     key === process.env.API_KEY ? {[securityId]: 'svc', name: 'svc'} : undefined,
 *   );
 *   app.service(ApiKeyAuthenticationStrategy);  // bind with AUTH_STRATEGY tag
 */
export class ApiKeyAuthenticationStrategy implements AuthenticationStrategy {
  /**
   * The name this strategy registers under. Reference it instead of the raw
   * `'api-key'` string when selecting the strategy (e.g.
   * `installMcpHttp(app, {strategyAuth: {strategy: ApiKeyAuthenticationStrategy.STRATEGY_NAME}})`).
   */
  static readonly STRATEGY_NAME = 'api-key';

  name = ApiKeyAuthenticationStrategy.STRATEGY_NAME;

  constructor(
    @inject(API_KEY_VERIFIER, {optional: true})
    private verify?: ApiKeyVerifier,
  ) {}

  async authenticate(request: Request): Promise<UserProfile | undefined> {
    const headerKey = request.headers['x-api-key'];
    const queryKey = (request.query as Record<string, unknown> | undefined)
      ?.apiKey;
    const apiKey =
      (typeof headerKey === 'string' ? headerKey : undefined) ??
      (typeof queryKey === 'string' ? queryKey : undefined);

    if (!apiKey) throw new Error('Missing API key');
    if (!this.verify) {
      throw new Error('No API key verifier bound (bind API_KEY_VERIFIER)');
    }
    const user = await this.verify(apiKey, request);
    if (!user) throw new Error('Invalid API key');
    return user;
  }
}
