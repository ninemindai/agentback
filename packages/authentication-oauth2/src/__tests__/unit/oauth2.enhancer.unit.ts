// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import type {OpenApiSpec} from '@agentback/openapi';
import {OAuth2SecuritySpecEnhancer} from '../../oauth2.enhancer.js';

function emptySpec(): OpenApiSpec {
  return {openapi: '3.1.0', info: {title: 't', version: '1'}, paths: {}};
}

describe('OAuth2SecuritySpecEnhancer', () => {
  it('adds a bearer-typed oauth2Auth security scheme', () => {
    const spec = new OAuth2SecuritySpecEnhancer().modifySpec(emptySpec());
    const scheme = (spec.components?.securitySchemes as Record<string, unknown>)
      .oauth2Auth as Record<string, unknown>;

    expect(scheme).toMatchObject({type: 'http', scheme: 'bearer'});
    // Opaque tokens are not JWTs — no bearerFormat is asserted.
    expect(scheme.bearerFormat).toBeUndefined();
  });

  it('preserves existing security schemes from other enhancers', () => {
    const base = emptySpec();
    base.components = {
      securitySchemes: {jwtAuth: {type: 'http', scheme: 'bearer'}},
    };

    const spec = new OAuth2SecuritySpecEnhancer().modifySpec(base);
    const schemes = spec.components?.securitySchemes as Record<string, unknown>;

    expect(schemes.jwtAuth).toBeDefined();
    expect(schemes.oauth2Auth).toBeDefined();
  });

  it('is idempotent — a second pass does not overwrite the scheme', () => {
    const enhancer = new OAuth2SecuritySpecEnhancer();
    const once = enhancer.modifySpec(emptySpec());
    const twice = enhancer.modifySpec(once);

    const schemes = twice.components?.securitySchemes as Record<
      string,
      unknown
    >;
    expect(Object.keys(schemes)).toEqual(['oauth2Auth']);
  });
});
