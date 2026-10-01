// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {authorize} from '@agentback/authorization';
import {onLog} from '@agentback/common';
import {Context} from '@agentback/context';
import {Application, extensionFilter, extensionFor} from '@agentback/core';
import {
  appResource,
  mcpServer,
  resource,
  tool,
} from '../../decorators/index.js';
import {resourceFragment, toolFragment} from '../../fragments.js';
import {MCP_APP_MIME_TYPE, MCP_SERVERS} from '../../keys.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {
  resourceContent,
  toBase64,
  toBase64Chunked,
} from '../../resource-content.js';
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

  @resource('data://plain', {
    extend: [resourceFragment({meta: {'acme/k': 'v'}})],
  })
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

  it.each<[string, unknown, RegExp]>([
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
    ['an empty ui', {ui: {}}, /: ui: must set resourceUri, visibility/],
    [
      'an empty fragment ui',
      {ui: {resourceUri: 'ui://a'}, extend: [toolFragment({ui: {}})]},
      /extend\[0\]\.ui: must set resourceUri, visibility/,
    ],
    [
      'an unprefixed meta key',
      {extend: [toolFragment({meta: {widget: 1}})]},
      /_meta key 'widget' needs a vendor prefix \('<vendor>\/<key>', e\.g\. 'openai\/widget' or 'com\.example\/widget'\); unprefixed keys are reserved for MCP/,
    ],
    ...['/x', 'a/', 'openai//x', 'a/b/c', '-a/x'].map(
      (key): [string, unknown, RegExp] => [
        `a malformed meta key '${key}'`,
        {extend: [toolFragment({meta: {[key]: 1}})]},
        /needs a vendor prefix/,
      ],
    ),
    ...['mcp.dev/x', 'tools.mcp.com/x', 'api.modelcontextprotocol.org/x'].map(
      (key): [string, unknown, RegExp] => [
        `an MCP-reserved prefix '${key}'`,
        {extend: [toolFragment({meta: {[key]: 1}})]},
        /reserved for the MCP spec/,
      ],
    ),
    [
      'a non-boolean *Hint annotation',
      {annotations: {readOnlyHint: 'yes'} as never},
      /annotations\.readOnlyHint must be a boolean, got "yes"/,
    ],
    [
      'a function-valued annotation in a fragment',
      {extend: [toolFragment({annotations: {fn: () => 1} as never})]},
      /extend\[0\]\.annotations\.fn must be JSON, got function/,
    ],
    [
      'an icon without src',
      {icons: [{mimeType: 'image/png'}] as never},
      /icons\[0\]\.src must be a non-empty string/,
    ],
    [
      'icons that are not an array',
      {icons: {} as never},
      /icons must be an array/,
    ],
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

  it('accepts vendor keys in the documented shapes', () => {
    expect(() => {
      class C {
        @tool('t', {
          extend: [
            toolFragment({
              meta: {'openai/ui': 1, 'com.example/x-y_z.1': 2, 'a/b': 3},
            }),
          ],
        })
        t() {}
      }
      void C;
    }).not.toThrow();
  });

  it('wraps a check error with the decorator prefix and keeps the cause', () => {
    const boom = new Error('host rule broken');
    let caught: unknown;
    try {
      class C {
        @tool('t', {
          extend: [
            toolFragment({
              check: () => {
                throw boom;
              },
            }),
          ],
        })
        t() {}
      }
      void C;
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe(
      "@tool('t') on C.t: host rule broken",
    );
    expect((caught as Error).cause).toBe(boom);
  });

  it('prefixes a non-Error thrown by a check', () => {
    expect(() => {
      class C {
        @tool('t', {
          extend: [
            toolFragment({
              check: () => {
                throw 'plain string';
              },
            }),
          ],
        })
        t() {}
      }
      void C;
    }).toThrow("@tool('t') on C.t: plain string");
  });

  it('does not freeze a shared fragment annotation object in place', async () => {
    const shared = {openWorldHint: true};
    @mcpServer()
    class Frozen {
      @tool('frozen', {extend: [toolFragment({annotations: shared})]})
      frozen() {
        return 'ok';
      }
    }
    const {client} = await connect({}, Frozen);
    const {tools} = await client.listTools();
    expect(tools[0].annotations).toEqual({openWorldHint: true});
    expect(Object.isFrozen(shared)).toBe(false);
    await client.close();
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
        _meta: {'acme/k': 'v'},
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

  it('rejects an unprefixed resource fragment meta key', () => {
    expect(() => {
      class C {
        @resource('data://x', {extend: [resourceFragment({meta: {mode: 1}})]})
        x() {}
      }
      void C;
    }).toThrow(
      /@resource\('data:\/\/x'\) on C\.x: _meta key 'mode' needs a vendor prefix/,
    );
  });

  it('rejects an unprefixed resourceContent meta key but allows ui', () => {
    expect(() => resourceContent({text: 'x'}, {meta: {mode: 1}})).toThrow(
      /resourceContent: _meta key 'mode' needs a vendor prefix/,
    );
    expect(() =>
      resourceContent({text: 'x'}, {meta: {ui: {domain: 'a.example.com'}}}),
    ).not.toThrow();
  });

  it.each([
    [
      '@resource',
      () => {
        class C {
          @resource('data://x', {icons: [{} as never]})
          x() {}
        }
        void C;
      },
      /@resource\('data:\/\/x'\) on C\.x: icons\[0\]\.src must be a non-empty string/,
    ],
    [
      '@appResource',
      () => {
        class C {
          @appResource('ui://x', {icons: [{src: ''}]})
          x() {}
        }
        void C;
      },
      /@appResource\('ui:\/\/x'\) on C\.x: icons\[0\]\.src must be a non-empty string/,
    ],
  ])('rejects an icon without src on %s', (_label, declare, message) => {
    expect(declare).toThrow(message);
  });

  it('rejects a server icon without src at construction', () => {
    expect(
      () =>
        new MCPServer(new Application(), {
          icons: [{mimeType: 'image/png'} as never],
        }),
    ).toThrow('MCPServerConfig.icons[0].src must be a non-empty string');
  });

  it('encodes blobs identically on the native and portable base64 paths', () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) % 256;
    expect(toBase64(bytes)).toBe(toBase64Chunked(bytes));
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
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
  @mcpServer()
  class C {
    @tool('dup')
    c() {
      return 'c';
    }
  }
  @mcpServer()
  class ScopedA {
    @tool('dup')
    @authorize({scopes: ['dup:read']})
    a() {
      return 'scoped-a';
    }
  }

  function makeApp(...classes: Function[]) {
    const app = new Application();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'dup-test',
      version: '1.0.0',
      transports: {stdio: false},
    });
    for (const c of classes) app.service(c as never);
    return app;
  }

  async function client(server: MCPServer, scopes?: string[]) {
    const sdk = server.buildServer({scopes});
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await sdk.connect(st);
    const c = new Client({name: 'dup-client', version: '0.0.0'});
    await c.connect(ct);
    return c;
  }

  async function callText(c: Client, name: string) {
    const r = await c.callTool({name, arguments: {}});
    return (r.content as {text: string}[])[0]?.text;
  }

  /** Capture `agentback:mcp:server` error logs while `fn` runs. */
  async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const dispose = onLog((ns, level, args) => {
      if (ns.startsWith('agentback:mcp:server') && level === 'error') {
        seen.push(args.map(String).join(' '));
      }
    });
    try {
      await fn();
    } finally {
      dispose();
    }
    return seen;
  }

  it('throws at start(), naming both members', async () => {
    const app = makeApp(A, B);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await expect(server.start()).rejects.toThrow(
      "Duplicate MCP tool name 'dup': A.a and B.b",
    );
  });

  it('throws again on a restart after a duplicate was bound', async () => {
    const app = makeApp(A);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await server.start();
    await server.stop();
    app.service(B);
    await expect(server.start()).rejects.toThrow(/Duplicate MCP tool name/);
  });

  it('buildServer() serves the app-level winner and logs the conflict once', async () => {
    const app = makeApp(A);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await server.start();
    app.service(B);
    const errors = await captureErrors(async () => {
      for (let i = 0; i < 2; i++) {
        const c = await client(server);
        const {tools} = await c.listTools();
        expect(tools.filter(t => t.name === 'dup')).toHaveLength(1);
        expect(await callText(c, 'dup')).toBe('a');
      }
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/dup A\.a B\.b$/);
    expect(errors[0]).toMatch(/unbind it/);
    await server.stop();
  });

  it('logs again for a different pair on the same name', async () => {
    const app = makeApp(A);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await server.start();
    app.service(B);
    const first = await captureErrors(async () => {
      await (await client(server)).listTools();
    });
    app.service(C);
    const second = await captureErrors(async () => {
      await (await client(server)).listTools();
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatch(/dup A\.a C\.c$/);
  });

  it('logs once per app: two apps in one process each log', async () => {
    const errors = await captureErrors(async () => {
      for (let i = 0; i < 2; i++) {
        const app = makeApp(A);
        const server = await app.get<MCPServer>('servers.MCPServer');
        await server.start();
        app.service(B);
        await (await client(server)).listTools();
        await (await client(server)).listTools();
      }
    });
    expect(errors).toHaveLength(2);
  });

  it('an app tool beats a child-context tool listed first by find()', async () => {
    const app = makeApp(A);
    const child = new Context(app, 'session');
    child.bind('services.B').toClass(B).apply(extensionFor(MCP_SERVERS));
    // `find` is child-first, so B precedes A in discovery order.
    const names = child
      .find(extensionFilter(MCP_SERVERS))
      .map(b => b.valueConstructor?.name);
    expect(names.indexOf('B')).toBeLessThan(names.indexOf('A'));
    const server = new MCPServer(child, {transports: {stdio: false}});
    const c = await client(server);
    expect(await callText(c, 'dup')).toBe('a');
  });

  it('hides the name when the winner is scope-hidden (the loser is never served)', async () => {
    const app = makeApp(ScopedA);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await server.start();
    app.service(B);
    const unscoped = await client(server, []);
    const {tools} = await unscoped.listTools();
    expect(tools.map(t => t.name)).not.toContain('dup');
    const denied = await unscoped.callTool({name: 'dup', arguments: {}});
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).not.toContain('"b"');
    // A caller holding the scope sees the name (the call itself is then
    // authorized per principal, which this test does not set up).
    const scoped = await client(server, ['dup:read']);
    expect((await scoped.listTools()).tools.map(t => t.name)).toContain('dup');
  });

  it('unbinding the winner makes the loser visible on the next request', async () => {
    const app = makeApp(A);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await server.start();
    app.service(B);
    expect(await callText(await client(server), 'dup')).toBe('a');
    app.unbind('services.A');
    expect(await callText(await client(server), 'dup')).toBe('b');
  });

  it('a child binding with the SAME key overrides the parent binding', async () => {
    const app = makeApp(A);
    const child = new Context(app, 'session');
    child.bind('services.A').toClass(B).apply(extensionFor(MCP_SERVERS));
    const server = new MCPServer(child, {transports: {stdio: false}});
    expect(await callText(await client(server), 'dup')).toBe('b');
  });

  it('tolerates the same class bound twice', async () => {
    const app = new Application();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({transports: {stdio: false}});
    app.service(A);
    app.controller(A);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await expect(server.start()).resolves.toBeUndefined();
    expect(() => server.buildServer()).not.toThrow();
    await server.stop();
  });
});
