// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {api, get, post} from '../../decorators/index.js';
import {
  assembleOpenApiSpec,
  getControllerSpec,
  resolveControllerSpec,
} from '../../controller-spec.js';

const Greeting = z.object({greeting: z.string()});
const HelloPath = z.object({name: z.string()});
const EchoIn = z.object({text: z.string().min(1)});
const EchoOut = z.object({echoed: z.string()});
const NotFound = z.object({error: z.string()});

@api({basePath: '/greet'})
class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {path: z.infer<typeof HelloPath>}) {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {
    body: EchoIn,
    response: EchoOut,
    description: 'Echoed input',
    responses: {404: {schema: NotFound, description: 'Not found'}},
  })
  async echo(input: {body: z.infer<typeof EchoIn>}) {
    return {echoed: input.body.text};
  }
}

class EmptyController {}

describe('resolveControllerSpec', () => {
  it('walks methods and emits paths', () => {
    const spec = resolveControllerSpec(GreetingController);
    expect(spec.basePath).toBe('/greet');
    expect(Object.keys(spec.paths ?? {})).toEqual(
      expect.arrayContaining(['/hello/{name}', '/echo']),
    );
  });

  it('returns an empty spec for a class with no @get/@post', () => {
    const spec = resolveControllerSpec(EmptyController);
    expect(spec.paths).toEqual({});
  });

  it('populates operation parameters from the path schema', () => {
    const spec = resolveControllerSpec(GreetingController);
    const op = (spec.paths!['/hello/{name}'] as Record<string, unknown>)
      .get as {
      parameters?: {name: string; in: string; required: boolean}[];
    };
    expect(op.parameters?.[0]).toMatchObject({
      name: 'name',
      in: 'path',
      required: true,
    });
  });

  it('populates requestBody from the body schema', () => {
    const spec = resolveControllerSpec(GreetingController);
    const op = (spec.paths!['/echo'] as Record<string, unknown>).post as {
      requestBody?: {content: Record<string, unknown>};
    };
    expect(op.requestBody?.content?.['application/json']).toBeDefined();
  });

  it('populates response 200 from the response schema', () => {
    const spec = resolveControllerSpec(GreetingController);
    const op = (spec.paths!['/hello/{name}'] as Record<string, unknown>)
      .get as {
      responses: Record<string, {content?: Record<string, unknown>}>;
    };
    expect(op.responses['200']).toBeDefined();
    expect(op.responses['200'].content?.['application/json']).toBeDefined();
  });

  it('emits documented additional responses (responses: {404: ...})', () => {
    const spec = resolveControllerSpec(GreetingController);
    const op = (spec.paths!['/echo'] as Record<string, unknown>).post as {
      responses: Record<string, {description: string}>;
    };
    expect(op.responses['404']).toMatchObject({description: 'Not found'});
  });

  it('emits a default response when no response is declared', () => {
    @api({basePath: '/x'})
    class NoResponse {
      @get('/y')
      noop() {}
    }
    const spec = resolveControllerSpec(NoResponse);
    const op = (spec.paths!['/y'] as Record<string, unknown>).get as {
      responses: Record<string, unknown>;
    };
    expect(op.responses.default).toBeDefined();
  });

  it('honors a custom success status via options.status', () => {
    @api({basePath: '/x'})
    class Created {
      @post('/x', {body: z.object({}), response: z.object({}), status: 201})
      make(_input: {body: {}}): {} {
        return {};
      }
    }
    const spec = resolveControllerSpec(Created);
    const op = (spec.paths!['/x'] as Record<string, unknown>).post as {
      responses: Record<string, unknown>;
    };
    expect(op.responses['201']).toBeDefined();
  });
});

describe('getControllerSpec', () => {
  it('caches the resolved spec on the class', () => {
    const a = getControllerSpec(GreetingController);
    const b = getControllerSpec(GreetingController);
    expect(a).toBe(b);
  });
});

describe('assembleOpenApiSpec', () => {
  it('produces an OpenAPI 3.1.1 document', () => {
    const doc = assembleOpenApiSpec([GreetingController]);
    expect(doc.openapi).toBe('3.1.1');
    expect(doc.info).toBeDefined();
    expect(doc.paths).toBeDefined();
  });

  it('prefixes paths with basePath', () => {
    const doc = assembleOpenApiSpec([GreetingController]);
    expect(Object.keys(doc.paths!)).toEqual(
      expect.arrayContaining(['/greet/hello/{name}', '/greet/echo']),
    );
  });

  it("collapses a root basePath of '/' instead of emitting '//path'", () => {
    @api({basePath: '/'})
    class Root {
      @get('/hello/{name}')
      hello() {}
    }
    const doc = assembleOpenApiSpec([Root]);
    expect(Object.keys(doc.paths!)).toContain('/hello/{name}');
    expect(Object.keys(doc.paths!)).not.toContain('//hello/{name}');
  });

  it('sets jsonSchemaDialect for OpenAPI 3.1', () => {
    const doc = assembleOpenApiSpec([GreetingController]);
    expect((doc as unknown as Record<string, unknown>).jsonSchemaDialect).toBe(
      'https://spec.openapis.org/oas/3.1/dialect/base',
    );
  });

  it('merges multiple controllers', () => {
    @api({basePath: '/other'})
    class Other {
      @get('/ping')
      ping() {}
    }
    const doc = assembleOpenApiSpec([GreetingController, Other]);
    expect(doc.paths!['/other/ping']).toBeDefined();
    expect(doc.paths!['/greet/echo']).toBeDefined();
  });

  it('accepts base spec overrides', () => {
    const doc = assembleOpenApiSpec([GreetingController], {
      info: {title: 'My API', version: '2.0.0'},
    });
    expect(doc.info).toMatchObject({title: 'My API', version: '2.0.0'});
  });
});
