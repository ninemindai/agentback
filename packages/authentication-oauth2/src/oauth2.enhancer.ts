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
 * Adds `securitySchemes.oauth2Auth` to the assembled OpenAPI document so
 * Swagger UI's Authorize button can prompt for a bearer token. The
 * controller-spec emits `security: [{oauth2Auth: []}]` on operations marked
 * `@authenticate('oauth2')`; this enhancer supplies the scheme those
 * references point at.
 *
 * The scheme is modelled as `http` / `bearer` rather than OpenAPI's `oauth2`
 * type on purpose: an `oauth2` scheme must declare flow URLs
 * (authorizationUrl/tokenUrl), which this package can't know — it validates
 * opaque tokens against any RFC 7662 endpoint without owning the flow. A
 * bearer scheme is the accurate description of "send your access token here".
 */
@injectable({
  tags: {
    [ContextTags.NAME]: 'oauth2.security.enhancer',
    extensionFor: OAS_ENHANCER_EXTENSION_POINT,
  },
})
export class OAuth2SecuritySpecEnhancer implements OASEnhancer {
  name = 'oauth2.security';

  modifySpec(spec: OpenApiSpec): OpenApiSpec {
    const components = {...(spec.components ?? {})};
    const schemes = {
      ...((components.securitySchemes as Record<string, unknown>) ?? {}),
    };
    if (!schemes.oauth2Auth) {
      schemes.oauth2Auth = {
        type: 'http',
        scheme: 'bearer',
        description:
          'OAuth2 access token validated via RFC 7662 introspection against the configured authorization server.',
      };
    }
    components.securitySchemes = schemes as typeof components.securitySchemes;
    return {...spec, components};
  }
}
