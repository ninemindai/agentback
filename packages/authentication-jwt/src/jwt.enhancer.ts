// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ContextTags, injectable} from '@agentback/context';
import {
  OASEnhancer,
  OAS_ENHANCER_EXTENSION_POINT,
  type OpenApiSpec,
} from '@agentback/openapi';

/**
 * Adds `securitySchemes.jwtAuth` to the assembled OpenAPI document so
 * Swagger UI's Authorize button can prompt for a JWT. The openapi
 * controller-spec emits `security: [{jwtAuth: []}]` on operations marked
 * with `@authenticate('jwt')`; this enhancer supplies the scheme
 * definition those references point at.
 */
@injectable({
  tags: {
    [ContextTags.NAME]: 'jwt.security.enhancer',
    extensionFor: OAS_ENHANCER_EXTENSION_POINT,
  },
})
export class JWTSecuritySpecEnhancer implements OASEnhancer {
  name = 'jwt.security';

  modifySpec(spec: OpenApiSpec): OpenApiSpec {
    const components = {...(spec.components ?? {})};
    const schemes = {
      ...((components.securitySchemes as Record<string, unknown>) ?? {}),
    };
    if (!schemes.jwtAuth) {
      schemes.jwtAuth = {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Bearer token issued by POST /auth/login.',
      };
    }
    components.securitySchemes = schemes as typeof components.securitySchemes;
    return {...spec, components};
  }
}
