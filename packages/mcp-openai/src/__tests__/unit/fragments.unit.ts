// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtemp, mkdir, symlink, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Application, Context} from '@agentback/core';
import {
  appResource,
  MCPBindings,
  MCPComponent,
  mcpServer,
  type MCPServer,
  tool,
} from '@agentback/mcp';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  choiceField,
  displayModes,
  fileEntrypoint,
  FileEntrypointIn,
  globalEntrypoint,
  mentionSearch,
  MentionSearchIn,
  MentionSearchOut,
  openaiForm,
  openaiUi,
  resourceField,
  resourcePath,
  textField,
  threadEntrypoint,
} from '../../index.js';

const ICON = {src: 'https://example.test/i.svg', mimeType: 'image/svg+xml'};
const UI = {resourceUri: 'ui://bits/library'};

/** Decorate a fresh class; return its error message, if any. */
function decorate(apply: (target: object) => void): string | undefined {
  try {
    @mcpServer()
    class T {
      m() {}
    }
    apply(T.prototype);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

function applyTool(name: string, opts: object) {
  return (proto: object) =>
    tool(name, opts as never)(
      proto,
      'm',
      Object.getOwnPropertyDescriptor(proto, 'm')!,
    );
}

async function listEntry(cls: Function) {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({transports: {stdio: false}});
  app.service(cls as never);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return server;
}

describe('entrypoint fragments', () => {
  it('emits openai/ui entrypoints on the tools/list entry', async () => {
    @mcpServer()
    class Library {
      @tool('cad_library', {
        title: 'Parts Library',
        icons: [ICON],
        ui: UI,
        extend: [
          openaiUi({
            entrypoints: [
              {type: 'global'},
              {type: 'thread'},
              {type: 'settings', searchTerms: ['parts']},
            ],
            preferredModelDisplayMode: 'fullscreen',
          }),
        ],
      })
      library() {
        return 'ok';
      }
    }
    const server = await listEntry(Library);
    const [t] = server.listTools();
    expect(t.meta.meta?.['openai/ui']).toEqual({
      entrypoints: [
        {type: 'global'},
        {type: 'thread'},
        {type: 'settings', searchTerms: ['parts']},
      ],
      preferredModelDisplayMode: 'fullscreen',
    });
  });

  it('requires a linked widget', () => {
    expect(
      decorate(applyTool('t', {icons: [ICON], extend: [globalEntrypoint()]})),
    ).toMatch(/link one with ui: \{resourceUri\}/);
  });

  it('requires the input to accept {} for global/thread/settings', () => {
    expect(
      decorate(
        applyTool('t', {
          ui: UI,
          icons: [ICON],
          input: z.object({id: z.string()}),
          extend: [threadEntrypoint()],
        }),
      ),
    ).toMatch(/thread entrypoint is opened with \{\}/);
    expect(
      decorate(
        applyTool('t', {
          ui: UI,
          icons: [ICON],
          input: z.object({id: z.string().optional()}),
          extend: [globalEntrypoint()],
        }),
      ),
    ).toBeUndefined();
  });

  it('requires a file entrypoint input to accept FileEntrypointIn', () => {
    expect(
      decorate(
        applyTool('t', {
          ui: UI,
          icons: [ICON],
          extend: [fileEntrypoint({extensions: ['.stl']})],
          input: z.object({path: z.string()}),
        }),
      ),
    ).toMatch(/FileEntrypointIn/);
    expect(
      decorate(
        applyTool('t', {
          ui: UI,
          icons: [ICON],
          input: FileEntrypointIn,
          extend: [fileEntrypoint({extensions: ['.stl', '.step']})],
        }),
      ),
    ).toBeUndefined();
    expect(() => fileEntrypoint({extensions: ['stl']})).toThrow(
      /file extensions like '\.stl'/,
    );
  });

  it('refuses duplicate entrypoint types and a bad quick action', () => {
    expect(() =>
      openaiUi({entrypoints: [{type: 'global'}, {type: 'global'}]}),
    ).toThrow(/more than one 'global'/);
    expect(() =>
      globalEntrypoint({
        quickAction: {
          title: 'New part',
          icons: [],
          target: {type: 'tool', name: 'new_part'},
        },
      }),
    ).toThrow(/at least one icon/);
  });

  it('tells you to combine entrypoints in one openaiUi', () => {
    expect(
      decorate(
        applyTool('t', {
          ui: UI,
          icons: [ICON],
          extend: [globalEntrypoint(), threadEntrypoint()],
        }),
      ),
    ).toMatch(/openai\/ui' is set twice/);
  });
});

describe('mentionSearch', () => {
  it('marks the tool and adds app visibility and readOnlyHint', async () => {
    @mcpServer()
    class Mentions {
      @tool('search_parts', {
        input: MentionSearchIn,
        output: MentionSearchOut,
        extend: [mentionSearch()],
      })
      search(_input: z.infer<typeof MentionSearchIn>) {
        return {items: []};
      }
    }
    const server = await listEntry(Mentions);
    const [t] = server.listTools();
    expect(t.meta.meta?.['openai/extensions']).toEqual({
      'mentions/search': {},
    });
    expect(t.meta.ui?.visibility).toEqual(['app']);
    expect(t.meta.annotations?.readOnlyHint).toBe(true);
  });

  it('checks the input and output shapes', () => {
    expect(
      decorate(
        applyTool('t', {output: MentionSearchOut, extend: [mentionSearch()]}),
      ),
    ).toMatch(/MentionSearchIn/);
    expect(
      decorate(
        applyTool('t', {input: MentionSearchIn, extend: [mentionSearch()]}),
      ),
    ).toMatch(/MentionSearchOut/);
  });
});

describe('displayModes', () => {
  it('emits openai/ui on the content item', async () => {
    @mcpServer()
    class W {
      @appResource('ui://bits/library', {
        extend: [displayModes({preferred: 'fullscreen'})],
      })
      w() {
        return '<html></html>';
      }
    }
    const server = await listEntry(W);
    const {contents} = await server.readResource('w');
    expect(contents[0]._meta?.['openai/ui']).toEqual({
      preferredDisplayMode: 'fullscreen',
    });
  });

  it('refuses pip and an unavailable preference', () => {
    expect(() => displayModes({available: ['pip' as never]})).toThrow(/pip/);
    expect(() =>
      displayModes({preferred: 'fullscreen', available: ['inline']}),
    ).toThrow(/not among available/);
    expect(() => displayModes({})).toThrow();
  });
});

describe('forms', () => {
  it('builds an extended form with OpenAI keys', () => {
    const form = openaiForm(
      {
        part: choiceField({
          title: 'Part',
          options: [
            {
              const: 'hex-bolt',
              title: 'M6 hex bolt',
              description: 'A fastener',
              thumbnail: {src: 'https://example.test/bolt.png'},
            },
          ],
        }),
        note: textField({
          pattern: '^[a-z]+$',
          suggestions: [{const: 'urgent', title: 'Urgent'}],
        }),
        files: resourceField({
          options: [{uri: 'cad://a', name: 'a'}],
          multiple: true,
          selection: 'explicit',
          default: ['cad://a'],
          userOptions: {kind: 'file', accept: ['.stl']},
        }),
      },
      {required: ['part']},
    );
    expect(form).toEqual({
      type: 'object',
      required: ['part'],
      properties: {
        part: {
          type: 'string',
          title: 'Part',
          oneOf: [
            {
              const: 'hex-bolt',
              title: 'M6 hex bolt',
              description: 'A fastener',
              'x-openai-thumbnail': {src: 'https://example.test/bolt.png'},
            },
          ],
        },
        note: {
          type: 'string',
          pattern: '^[a-z]+$',
          'x-openai-suggestions': [{const: 'urgent', title: 'Urgent'}],
        },
        files: {
          type: 'array',
          items: {type: 'string', format: 'uri'},
          default: ['cad://a'],
          'x-openai-input': {
            type: 'resource',
            options: [{uri: 'cad://a', name: 'a'}],
            userOptions: {kind: 'file', accept: ['.stl']},
            selection: 'explicit',
          },
        },
      },
    });
  });

  it('enforces the spec rules for resource fields and options', () => {
    const options = [{uri: 'cad://a', name: 'a'}];
    expect(() => resourceField({options, selection: 'implicit'})).toThrow(
      /only to multiple/,
    );
    expect(() =>
      resourceField({
        options,
        multiple: true,
        selection: 'implicit',
        default: ['cad://a'],
      }),
    ).toThrow(/implicit selection cannot set a default/);
    expect(() => resourceField({options, default: 'cad://zzz'})).toThrow(
      /must name one of the supplied options/,
    );
    expect(() =>
      choiceField({
        options: [
          {const: 'a', title: 'A', thumbnail: {src: 'http://insecure/a.png'}},
        ],
      }),
    ).toThrow(/https URL/);
    expect(() => openaiForm({}, {required: ['x']})).toThrow(/not a field/);
  });
});

describe('resourcePath', () => {
  async function tree() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'rp-')));
    const root = join(base, 'root');
    await mkdir(root);
    await writeFile(join(root, 'part.stl'), 'x');
    await writeFile(join(root, '..odd.stl'), 'x');
    await mkdir(join(base, 'root-sibling'));
    await writeFile(join(base, 'root-sibling', 'secret'), 'x');
    await symlink(join(base, 'root-sibling', 'secret'), join(root, 'link'));
    return {base, root};
  }
  const meta = (path: unknown) => ({'openai/resource': {path}});

  it('returns the resolved path inside a root', async () => {
    const {root} = await tree();
    const p = join(root, 'part.stl');
    expect(await resourcePath({meta: meta(p)}, {roots: [root]})).toBe(p);
    const odd = join(root, '..odd.stl');
    expect(await resourcePath({meta: meta(odd)}, {roots: [root]})).toBe(odd);
    expect(await resourcePath({meta: {}}, {roots: [root]})).toBeUndefined();
  });

  it('refuses a path outside every root, by prefix or symlink', async () => {
    const {base, root} = await tree();
    await expect(
      resourcePath(
        {meta: meta(join(base, 'root-sibling', 'secret'))},
        {roots: [root]},
      ),
    ).rejects.toMatchObject({code: 'forbidden'});
    await expect(
      resourcePath({meta: meta(join(root, 'link'))}, {roots: [root]}),
    ).rejects.toMatchObject({code: 'forbidden'});
    await expect(
      resourcePath(
        {meta: meta(join(root, '..', 'root-sibling', 'secret'))},
        {
          roots: [root],
        },
      ),
    ).rejects.toMatchObject({code: 'forbidden'});
  });

  it('is off on HTTP requests unless allowed, and validates the path', async () => {
    const {root} = await tree();
    const p = join(root, 'part.stl');
    const request = new Request('http://localhost/mcp');
    await expect(
      resourcePath({meta: meta(p), request}, {roots: [root]}),
    ).rejects.toMatchObject({code: 'forbidden'});
    expect(
      await resourcePath(
        {meta: meta(p), request},
        {roots: [root], allowHttp: true},
      ),
    ).toBe(p);
    await expect(
      resourcePath({meta: meta('relative/x')}, {roots: [root]}),
    ).rejects.toMatchObject({code: 'invalid_input'});
    await expect(
      resourcePath({meta: meta(42)}, {roots: [root]}),
    ).rejects.toMatchObject({code: 'invalid_input'});
    await expect(
      resourcePath({meta: meta(join(root, 'nope'))}, {roots: [root]}),
    ).rejects.toMatchObject({code: 'not_found'});
    // Outside the roots, a missing file answers like an existing one.
    await expect(
      resourcePath({meta: meta('/definitely/not/here')}, {roots: [root]}),
    ).rejects.toMatchObject({code: 'forbidden'});
  });

  it('reads only a real transport request from a context', async () => {
    const {root} = await tree();
    const p = join(root, 'part.stl');
    const ctx = new Context('req');
    ctx.bind(MCPBindings.REQUEST_META).to(meta(p));
    // In-process (simulated) — no transport extras, no path.
    expect(await resourcePath(ctx, {roots: [root]})).toBeUndefined();
    ctx.bind(MCPBindings.REQUEST_EXTRA).to({mcpReq: {}} as never);
    expect(await resourcePath(ctx, {roots: [root]})).toBe(p);
    ctx
      .bind(MCPBindings.REQUEST_EXTRA)
      .to({mcpReq: {}, http: {req: new Request('http://x/mcp')}} as never);
    await expect(resourcePath(ctx, {roots: [root]})).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
