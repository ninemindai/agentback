// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import {MetadataAccessor} from '@agentback/metadata';
import type {AuthorizationMetadata} from './types.js';

export namespace AuthorizationKeys {
  export const METADATA = MetadataAccessor.create<
    AuthorizationMetadata,
    MethodDecorator
  >('authorization:method');
  export const CLASS_METADATA = MetadataAccessor.create<
    AuthorizationMetadata,
    ClassDecorator
  >('authorization:class');
}

/** Tag for binding global voters via the IoC container. */
export const GLOBAL_VOTER_TAG = 'authorization.voter';

/**
 * Binding key for the current request's tenant, read by the {@link tenantOnly}
 * voter. Bind a tenant id string or an object with an `id` field into the
 * request context under this key (e.g. from an authentication strategy or a
 * multi-tenancy interceptor).
 */
export const AUTHORIZATION_CURRENT_TENANT = BindingKey.create<
  {id?: string} | string
>('authorization.currentTenant');
