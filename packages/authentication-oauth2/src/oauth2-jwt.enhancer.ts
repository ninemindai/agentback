// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ContextTags, injectable} from '@agentback/context';
import {
  OASEnhancer,
  OAS_ENHANCER_EXTENSION_POINT,
  type OpenApiSpec,
} from '@agentback/openapi';

/**
 * Adds `securitySchemes['oauth2-jwtAuth']` to the assembled OpenAPI document so
 * Swagger UI's Authorize button can prompt for a JWT access token. The
 * controller-spec emits `security: [{'oauth2-jwtAuth': []}]` on operations
 * marked `@authenticate('oauth2-jwt')`.
 */
@injectable({
  tags: {
    [ContextTags.NAME]: 'oauth2-jwt.security.enhancer',
    extensionFor: OAS_ENHANCER_EXTENSION_POINT,
  },
})
export class OAuth2JwtSecuritySpecEnhancer implements OASEnhancer {
  name = 'oauth2-jwt.security';

  modifySpec(spec: OpenApiSpec): OpenApiSpec {
    const components = {...(spec.components ?? {})};
    const schemes = {
      ...((components.securitySchemes as Record<string, unknown>) ?? {}),
    };
    if (!schemes['oauth2-jwtAuth']) {
      schemes['oauth2-jwtAuth'] = {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'OAuth2 JWT access token, verified locally against the authorization server JWKS.',
      };
    }
    components.securitySchemes = schemes as typeof components.securitySchemes;
    return {...spec, components};
  }
}
