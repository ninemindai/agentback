// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {ConsolidationEnhancer} from '../../enhancers/consolidate.enhancer.js';
import {InfoEnhancer} from '../../enhancers/info.enhancer.js';
import type {OpenApiSpec} from '../../types.js';
import {createEmptyApiSpec} from '../../types.js';

describe('InfoEnhancer', () => {
  it('merges info fields into the spec', () => {
    const enhancer = new InfoEnhancer({
      title: 'My Service',
      version: '1.2.3',
      description: 'demo',
    });
    const result = enhancer.modifySpec(createEmptyApiSpec());
    expect(result.info).toMatchObject({
      title: 'My Service',
      version: '1.2.3',
      description: 'demo',
    });
  });

  it('preserves existing info fields not overridden', () => {
    const enhancer = new InfoEnhancer({description: 'added'});
    const spec = createEmptyApiSpec();
    spec.info.title = 'Existing';
    const result = enhancer.modifySpec(spec);
    expect(result.info).toMatchObject({
      title: 'Existing',
      description: 'added',
    });
  });
});

describe('ConsolidationEnhancer', () => {
  it('hoists inline titled schemas in responses to components.schemas', () => {
    const enhancer = new ConsolidationEnhancer();
    const spec: OpenApiSpec = {
      ...createEmptyApiSpec(),
      paths: {
        '/widget': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      title: 'Widget',
                      type: 'object',
                      properties: {id: {type: 'string'}},
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as OpenApiSpec;
    const result = enhancer.modifySpec(spec);
    const schemas = result.components?.schemas as Record<string, unknown>;
    expect(schemas?.Widget).toMatchObject({type: 'object', title: 'Widget'});
    const op = result.paths?.['/widget'] as Record<string, unknown>;
    const media = (op.get as Record<string, unknown>).responses as Record<
      string,
      unknown
    >;
    const ok = (media['200'] as Record<string, unknown>).content as Record<
      string,
      unknown
    >;
    const json = ok['application/json'] as Record<string, unknown>;
    expect(json.schema).toEqual({$ref: '#/components/schemas/Widget'});
  });

  it('leaves untitled inline schemas in place', () => {
    const enhancer = new ConsolidationEnhancer();
    const spec: OpenApiSpec = {
      ...createEmptyApiSpec(),
      paths: {
        '/widget': {
          get: {
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {schema: {type: 'object'}},
                },
              },
            },
          },
        },
      },
    } as OpenApiSpec;
    const result = enhancer.modifySpec(spec);
    expect(result.components?.schemas).toEqual({});
  });
});
