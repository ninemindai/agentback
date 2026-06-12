// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import {ClientApplication, Subject, UserProfile} from './types.js';

/**
 * Binding keys for security related metadata
 */
export namespace SecurityBindings {
  /**
   * Binding key for subject
   */
  export const SUBJECT = BindingKey.create<Subject>('security.subject');

  /**
   * Binding key for current user profile
   */
  export const USER = BindingKey.create<UserProfile>('security.user');

  /**
   * Binding key for the current request's client application. Deposit it from
   * an authentication strategy (e.g. API key / client credentials); read by
   * authorization scope governance.
   */
  export const CLIENT_APPLICATION = BindingKey.create<ClientApplication>(
    'security.clientApplication',
  );
}
