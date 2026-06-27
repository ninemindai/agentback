// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {injectable, ContextTags} from '@agentback/core';
import type {
  OpenApiSpec,
  ParameterObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SchemasObject,
} from '../types.js';
import {isSchemaObject} from '../types.js';
import {OASEnhancer, OAS_ENHANCER_EXTENSION_POINT} from './types.js';

/**
 * Walks operations, finds inline SchemaObjects that have a `title`, hoists
 * them into `components.schemas`, and replaces the original location with
 * a `$ref`. Mirrors @loopback/rest's ConsolidationEnhancer behavior.
 */
@injectable({
  tags: {
    [ContextTags.NAME]: 'consolidate.enhancer',
    extensionFor: OAS_ENHANCER_EXTENSION_POINT,
  },
})
export class ConsolidationEnhancer implements OASEnhancer {
  name = 'consolidate';

  modifySpec(spec: OpenApiSpec): OpenApiSpec {
    const schemas = {
      ...(spec.components?.schemas ?? {}),
    } as Record<string, SchemaObject | ReferenceObject>;

    const rewrite = (s: SchemaObject | ReferenceObject | undefined) => {
      if (!isSchemaObject(s)) return s;
      if (s.title && !schemas[s.title]) {
        schemas[s.title] = s;
        return {$ref: `#/components/schemas/${s.title}`};
      }
      return s;
    };

    const paths = spec.paths ?? {};
    for (const path of Object.keys(paths)) {
      const pathItem = paths[path] as Record<string, unknown>;
      for (const verb of Object.keys(pathItem)) {
        const op = pathItem[verb];
        if (!op || typeof op !== 'object') continue;
        const operation = op as Record<string, unknown>;

        // parameters
        const params = operation.parameters as ParameterObject[] | undefined;
        if (Array.isArray(params)) {
          for (const p of params) {
            const rewritten = rewrite(p.schema);
            if (rewritten) p.schema = rewritten;
          }
        }

        // requestBody
        const rb = operation.requestBody as RequestBodyObject | undefined;
        if (rb?.content) {
          for (const ct of Object.keys(rb.content)) {
            const media = rb.content[ct];
            const rewritten = rewrite(media.schema);
            if (rewritten) media.schema = rewritten;
          }
        }

        // responses
        const responses = operation.responses as
          | Record<string, ResponseObject>
          | undefined;
        if (responses) {
          for (const code of Object.keys(responses)) {
            const r = responses[code];
            if (!r?.content) continue;
            for (const ct of Object.keys(r.content)) {
              const media = r.content[ct];
              const rewritten = rewrite(media.schema);
              if (rewritten) media.schema = rewritten;
            }
          }
        }
      }
    }

    return {
      ...spec,
      components: {
        ...(spec.components ?? {}),
        schemas: schemas as SchemasObject,
      },
    };
  }
}
