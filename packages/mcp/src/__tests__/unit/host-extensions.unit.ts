// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {
  appResource,
  mcpServer,
  resource,
  tool,
} from '../../decorators/index.js';
import {resourceFragment, toolFragment} from '../../fragments.js';
import {MCP_APP_MIME_TYPE} from '../../keys.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {resourceContent} from '../../resource-content.js';
import type {MCPServerConfig} from '../../types.js';

// P1-7 phase 1a: host-neutral seams for host extensions (ChatGPT, Claude).
// See docs/proposals/host-extensions.md §4.

const ICON = {src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml'};
const sidebar = toolFragment({
  meta: {'acme/ui': {entrypoints: [{type: 'global'}]}},
});

@mcpServer()
class HostTools {
  @tool('library', {
    title: 'Parts Library',
    icons: [ICON],
    annotations: {readOnlyHint: true},
    ui: {resourceUri: 'ui://bits/library'},
    extend: [sidebar],
  })
  library() {
    return {parts: []};
  }

  @tool('mentions', {
    input: z.object({query: z.string()}),
    ui: {visibility: ['app']},
  })
  mentions(_input: {query: string}) {
    return {items: []};
  }

  @tool('wipe', {confirm: true})
  wipe() {
    return 'wiped';
  }

  @appResource('ui://bits/library', {
    title: 'Library widget',
    icons: [ICON],
    csp: {connectDomains: ['https://api.example.com']},
    domain: 'abc.example-host.com',
    prefersBorder: false,
    extend: [resourceFragment({meta: {'acme/display': {mode: 'fullscreen'}}})],
  })
  libraryWidget() {
    return '<!doctype html><html></html>';
  }

  @resource('file://logo.png', {mimeType: 'image/png'})
  logo() {
    return resourceContent({blob: new Uint8Array([0, 1, 2, 255])});
  }

  @appResource('ui://bits/dynamic', {domain: 'static.example.com'})
  dynamic() {
    return [
      resourceContent(
        {text: '<html>a</html>'},
        {meta: {ui: {domain: 'call.example.com'}, 'acme/x': 1}},
      ),
      resourceContent({text: '<html>b</html>'}),
    ];
  }

  @resource('data://plain', {extend: [resourceFragment({meta: {k: 'v'}})]})
  plain() {
    return {hello: 'world'};
  }
}

async function connect(
  config: Partial<MCPServerConfig> = {},
  ...classes: Function[]
): Promise<{client: Client; server: MCPServer}> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'host-ext-test',
    version: '1.0.0',
    transports: {stdio: false},
    ...config,
  });
  for (const c of classes.length ? classes : [HostTools]) {
    app.service(c as never);
  }
  const server = await app.get<MCPServer>('servers.MCPServer');
  const sdkServer = server.buildServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await sdkServer.connect(serverTransport);
  const client = new Client({name: 'test-client', version: '0.0.0'});
  await client.connect(clientTransport);
  return {client, server};
}

describe('@tool icons, annotations and extend fragments', () => {
  it('emits icons, annotations and merged _meta on tools/list', async () => {
    const {client} = await connect();
    const {tools} = await client.listTools();
    const library = tools.find(t => t.name === 'library')!;
    expect(library.title).toBe('Parts Library');
    expect(library.icons).toEqual([ICON]);
    expect(library.annotations).toEqual({readOnlyHint: true});
    expect(library._meta).toEqual({
      'acme/ui': {entrypoints: [{type: 'global'}]},
      ui: {resourceUri: 'ui://bits/library'},
    });
    await client.close();
  });

  it('emits ui.visibility without a widget link', async () => {
    const {client} = await connect();
    const {tools} = await client.listTools();
    const mentions = tools.find(t => t.name === 'mentions')!;
    expect(mentions._meta).toEqual({ui: {visibility: ['app']}});
    await client.close();
  });

  it('app-only visibility is not authorization: the tool stays callable', async () => {
    const {client} = await connect();
    const res = await client.callTool({
      name: 'mentions',
      arguments: {query: 'x'},
    });
    expect(res.isError).toBeFalsy();
    await client.close();
  });

  it('confirm: implies destructiveHint', async () => {
    const {client} = await connect();
    const {tools} = await client.listTools();
    expect(tools.find(t => t.name === 'wipe')!.annotations).toEqual({
      destructiveHint: true,
    });
    await client.close();
  });

  it('keeps an explicit destructiveHint: false on a confirm: tool', () => {
    class C {
      @tool('t', {confirm: true, annotations: {destructiveHint: false}})
      t() {}
    }
    void C;
  });

  it('throws on confirm: with readOnlyHint: true', () => {
    expect(() => {
      class C {
        @tool('t', {confirm: true, annotations: {readOnlyHint: true}})
        t() {}
      }
      void C;
    }).toThrow(/@tool\('t'\) on C\.t: confirm: and annotations\.readOnlyHint/);
  });

  it('unions ui.visibility across ui: and fragments', () => {
    @mcpServer()
    class V {
      @tool('v', {
        ui: {resourceUri: 'ui://v', visibility: ['model']},
        extend: [toolFragment({ui: {visibility: ['app', 'model']}})],
      })
      v() {}
    }
    return connect({}, V).then(async ({client}) => {
      const {tools} = await client.listTools();
      expect(tools[0]._meta).toEqual({
        ui: {resourceUri: 'ui://v', visibility: ['model', 'app']},
      });
      await client.close();
    });
  });

  it.each([
    [
      'a conflicting ui.resourceUri',
      {
        ui: {resourceUri: 'ui://a'},
        extend: [toolFragment({ui: {resourceUri: 'ui://b'}})],
      },
      /extend\[0\] sets ui\.resourceUri 'ui:\/\/b'/,
    ],
    [
      'a conflicting annotation',
      {
        annotations: {openWorldHint: true},
        extend: [toolFragment({annotations: {openWorldHint: false}})],
      },
      /annotations\.openWorldHint/,
    ],
    [
      'the same meta key twice',
      {
        extend: [
          toolFragment({meta: {'acme/a': 1}}),
          toolFragment({meta: {'acme/a': 2}}),
        ],
      },
      /meta key 'acme\/a' is set twice/,
    ],
    [
      'a meta ui key',
      {extend: [toolFragment({meta: {ui: {}}})]},
      /meta key 'ui' is reserved/,
    ],
    [
      'a spec-reserved meta key',
      {extend: [toolFragment({meta: {'io.modelcontextprotocol/x': 1}})]},
      /reserved for the MCP spec/,
    ],
    [
      'a non-JSON meta value',
      {extend: [toolFragment({meta: {'acme/d': new Date() as never}})]},
      /must be a plain JSON object/,
    ],
    [
      'a raw object instead of a fragment',
      {extend: [{meta: {}} as never]},
      /extend\[0\] is not a tool fragment/,
    ],
    ['an empty ui', {ui: {}}, /ui: must set resourceUri, visibility/],
    [
      'annotations.title',
      {annotations: {title: 'x'} as never},
      /annotations\.title is not supported/,
    ],
  ])('throws at decoration on %s', (_label, options, message) => {
    expect(() => {
      class C {
        @tool('t', options as never)
        t(_input?: unknown) {}
      }
      void C;
    }).toThrow(message);
  });

  it('runs fragment checks against the resolved input schema', () => {
    const needsEmptyInput = toolFragment({
      check: ({input}) => {
        if (input && !(input as z.ZodType).safeParse({}).success) {
          throw new Error('entrypoint requires input: to accept {}');
        }
      },
    });
    expect(() => {
      class C {
        @tool('t', {
          input: z.object({q: z.string()}),
          extend: [needsEmptyInput],
        })
        t(_input: {q: string}) {}
      }
      void C;
    }).toThrow("@tool('t') on C.t: entrypoint requires input: to accept {}");
    // Accepts when the input is satisfiable by {}.
    class D {
      @tool('t', {
        input: z.object({q: z.string().optional()}),
        extend: [needsEmptyInput],
      })
      t(_input: {q?: string}) {}
    }
    void D;
  });

  it('does not freeze an author constant shared across tools', async () => {
    const shared = {'acme/k': {v: 1}};
    @mcpServer()
    class S {
      @tool('s', {extend: [toolFragment({meta: shared})]})
      s() {}
    }
    const {client} = await connect({}, S);
    await client.listTools();
    expect(Object.isFrozen(shared['acme/k'])).toBe(false);
    await client.close();
  });
});

describe('resources: title, icons, content _meta, resourceContent', () => {
  it('lists title and icons, and keeps _meta off the list entry', async () => {
    const {client} = await connect();
    const {resources} = await client.listResources();
    const widget = resources.find(r => r.uri === 'ui://bits/library')!;
    expect(widget.title).toBe('Library widget');
    expect(widget.icons).toEqual([ICON]);
    expect(widget.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(widget._meta).toBeUndefined();
    await client.close();
  });

  it('@appResource puts _meta.ui and fragment meta on the content item', async () => {
    const {client} = await connect();
    const read = await client.readResource({uri: 'ui://bits/library'});
    expect(read.contents).toEqual([
      {
        uri: 'ui://bits/library',
        mimeType: MCP_APP_MIME_TYPE,
        text: '<!doctype html><html></html>',
        _meta: {
          ui: {
            csp: {connectDomains: ['https://api.example.com']},
            domain: 'abc.example-host.com',
            prefersBorder: false,
          },
          'acme/display': {mode: 'fullscreen'},
        },
      },
    ]);
    await client.close();
  });

  it('serves a blob base64-encoded', async () => {
    const {client} = await connect();
    const read = await client.readResource({uri: 'file://logo.png'});
    expect(read.contents).toEqual([
      {uri: 'file://logo.png', mimeType: 'image/png', blob: 'AAEC/w=='},
    ]);
    await client.close();
  });

  it('merges per-call meta over static meta, ui key by key', async () => {
    const {client} = await connect();
    const read = await client.readResource({uri: 'ui://bits/dynamic'});
    expect(read.contents).toEqual([
      {
        uri: 'ui://bits/dynamic',
        mimeType: MCP_APP_MIME_TYPE,
        text: '<html>a</html>',
        _meta: {ui: {domain: 'call.example.com'}, 'acme/x': 1},
      },
      {
        uri: 'ui://bits/dynamic',
        mimeType: MCP_APP_MIME_TYPE,
        text: '<html>b</html>',
        _meta: {ui: {domain: 'static.example.com'}},
      },
    ]);
    await client.close();
  });

  it('keeps plain returns as JSON text, with static fragment meta', async () => {
    const {client} = await connect();
    const read = await client.readResource({uri: 'data://plain'});
    expect(read.contents).toEqual([
      {
        uri: 'data://plain',
        mimeType: 'text/plain',
        text: '{"hello":"world"}',
        _meta: {k: 'v'},
      },
    ]);
    await client.close();
  });

  it('readResource (in-process) returns the same shape', async () => {
    const {server, client} = await connect();
    const read = await server.readResource('logo');
    expect(read.contents[0].blob).toBe('AAEC/w==');
    await client.close();
  });

  it.each([
    [
      'a non-ui:// @appResource URI',
      () => appResource('https://x'),
      /must start with ui:\/\//,
    ],
    [
      'an unknown csp key',
      () => appResource('ui://x', {csp: {scriptDomains: []} as never}),
      /unknown csp key 'scriptDomains'/,
    ],
    [
      'an unknown permission',
      () => appResource('ui://x', {permissions: {usb: {}} as never}),
      /unknown permission 'usb'/,
    ],
  ])('throws on %s', (_label, make, message) => {
    expect(make).toThrow(message);
  });

  it('reserves _meta.ui on a plain @resource', () => {
    expect(() => {
      class C {
        @resource('data://x', {extend: [resourceFragment({meta: {ui: {}}})]})
        x() {}
      }
      void C;
    }).toThrow(/@resource\('data:\/\/x'\) on C\.x: meta key 'ui' is reserved/);
  });

  it('rejects mixing resourceContent items with plain values', async () => {
    @mcpServer()
    class M {
      @resource('data://mixed')
      mixed() {
        return [resourceContent({text: 'a'}), 'b'];
      }
    }
    const {client} = await connect({}, M);
    await expect(client.readResource({uri: 'data://mixed'})).rejects.toThrow();
    await client.close();
  });
});

describe('server identity and capabilities', () => {
  it('advertises title, icons, websiteUrl and extra capabilities', async () => {
    const {client} = await connect({
      title: 'Bits & Bolts',
      icons: [ICON],
      websiteUrl: 'https://bits.example.com',
      capabilities: {
        extensions: {'acme/settings': {readTool: 'r', updateTool: 'u'}},
        experimental: {'acme/settings': {readTool: 'r', updateTool: 'u'}},
      },
    });
    expect(client.getServerVersion()).toMatchObject({
      name: 'host-ext-test',
      title: 'Bits & Bolts',
      icons: [ICON],
      websiteUrl: 'https://bits.example.com',
    });
    const caps = client.getServerCapabilities()!;
    expect(caps.extensions).toEqual({
      'acme/settings': {readTool: 'r', updateTool: 'u'},
    });
    expect(caps.experimental).toEqual({
      'acme/settings': {readTool: 'r', updateTool: 'u'},
    });
    expect(caps.tools).toBeDefined();
    await client.close();
  });

  it('refuses to override a framework-owned capability', async () => {
    await expect(connect({capabilities: {tools: {}} as never})).rejects.toThrow(
      /capabilities\.tools is not allowed/,
    );
  });
});

describe('duplicate tool names', () => {
  @mcpServer()
  class A {
    @tool('dup')
    a() {
      return 'a';
    }
  }
  @mcpServer()
  class B {
    @tool('dup')
    b() {
      return 'b';
    }
  }

  it('throws at buildServer, naming both members', async () => {
    await expect(connect({}, A, B)).rejects.toThrow(
      "Duplicate MCP tool name 'dup': A.a and B.b",
    );
  });

  it('tolerates the same class bound twice', async () => {
    const app = new Application();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({transports: {stdio: false}});
    app.service(A);
    app.controller(A);
    const server = await app.get<MCPServer>('servers.MCPServer');
    expect(() => server.buildServer()).not.toThrow();
  });
});
