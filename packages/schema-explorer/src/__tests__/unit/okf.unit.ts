// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {inventoryToOkf} from '../../okf.js';
import type {SchemaInventory} from '../../inventory.js';

// A minimal hand-built inventory: one `User` entity backed by a Drizzle table,
// produced as a REST response (`POST /users`) and an MCP tool output
// (`create_user`). Object identity has already collapsed both usages onto one
// node — exactly what `buildSchemaInventory` would hand us.
function userInventory(): SchemaInventory {
  return {
    nodes: [
      {
        id: 's0',
        name: 'User',
        bound: true,
        bindingKey: 'schemas.User',
        origin: {table: 'users'},
        jsonSchema: {
          type: 'object',
          properties: {
            id: {type: 'number'},
            name: {type: 'string'},
          },
          required: ['id', 'name'],
        },
        fieldCount: 2,
        usages: [
          {
            surface: 'rest',
            role: 'response',
            ref: 'POST /users',
            surfaceId: 'rest::POST /users',
            controller: 'UserController',
            method: 'create',
          },
          {
            surface: 'mcp',
            role: 'output',
            ref: 'create_user',
            surfaceId: 'mcp::create_user',
            controller: 'UserController',
            method: 'createUser',
          },
        ],
      },
    ],
    surfaces: [
      {
        id: 'rest::POST /users',
        surface: 'rest',
        ref: 'POST /users',
        controller: 'UserController',
        method: 'create',
      },
      {
        id: 'mcp::create_user',
        surface: 'mcp',
        ref: 'create_user',
        controller: 'UserController',
        method: 'createUser',
      },
    ],
    edges: [
      {from: 's0', to: 'rest::POST /users', role: 'response', surface: 'rest'},
      {from: 's0', to: 'mcp::create_user', role: 'output', surface: 'mcp'},
    ],
  };
}

/** Pull one file's content from the bundle by its path. */
function file(bundle: {files: {path: string; content: string}[]}, path: string) {
  const f = bundle.files.find(x => x.path === path);
  if (!f) throw new Error(`expected file ${path}; got ${bundle.files.map(x => x.path).join(', ')}`);
  return f.content;
}

describe('inventoryToOkf', () => {
  it('emits a two-tier bundle with index files for both tiers', () => {
    const bundle = inventoryToOkf(userInventory());
    const paths = bundle.files.map(f => f.path);

    expect(paths).toContain('index.md');
    expect(paths).toContain('schemas/index.md');
    expect(paths).toContain('surfaces/index.md');
    expect(paths).toContain('schemas/user.md');
    expect(paths).toContain('surfaces/rest-post-users.md');
    expect(paths).toContain('surfaces/mcp-create-user.md');
  });

  it('returns files sorted by path (deterministic, no timestamps)', () => {
    const bundle = inventoryToOkf(userInventory());
    const paths = bundle.files.map(f => f.path);
    expect(paths).toEqual([...paths].sort());
    // Determinism: emitting twice yields byte-identical output.
    expect(inventoryToOkf(userInventory())).toEqual(bundle);
    for (const f of bundle.files) expect(f.content).not.toMatch(/timestamp/i);
  });

  it('types a Drizzle-backed schema as `table` with its origin and fields', () => {
    const doc = file(inventoryToOkf(userInventory()), 'schemas/user.md');

    // Frontmatter: table type (it has a Drizzle origin), surfaces as tags.
    expect(doc).toMatch(/^---\n/);
    expect(doc).toContain('type: table');
    expect(doc).toMatch(/tags:.*mcp/);
    expect(doc).toMatch(/tags:.*rest/);

    // Body: title, Drizzle origin, and a fields section listing both columns.
    expect(doc).toContain('# User');
    expect(doc).toContain('users'); // the backing table name
    expect(doc).toContain('id');
    expect(doc).toContain('name');
  });

  it('renders field types: format, enum, and empty schema', () => {
    const inv = userInventory();
    inv.nodes[0]!.jsonSchema = {
      type: 'object',
      properties: {
        createdAt: {type: 'string', format: 'date-time'},
        role: {enum: ['admin', 'user']},
        meta: {}, // unrepresentable -> any, not "unknown"
      },
    };
    const doc = file(inventoryToOkf(inv), 'schemas/user.md');
    expect(doc).toContain('| createdAt | string (date-time) |');
    expect(doc).toContain('| role | admin \\| user |');
    expect(doc).toContain('| meta | any |');
    expect(doc).not.toContain('unknown');
  });

  it('cross-links a schema to every surface that uses it (role-labeled)', () => {
    const doc = file(inventoryToOkf(userInventory()), 'schemas/user.md');
    // Relative links into the surfaces tier, with the role shown.
    expect(doc).toContain('../surfaces/rest-post-users.md');
    expect(doc).toContain('../surfaces/mcp-create-user.md');
    expect(doc).toContain('response');
    expect(doc).toContain('output');
  });

  it('omits dev-tooling surfaces and the schemas used only by them', () => {
    const inv = userInventory();
    // Add a schema-explorer self-surface and a node used only by it.
    inv.surfaces.push({
      id: 'rest::GET /schema-explorer/api/schemas',
      surface: 'rest',
      ref: 'GET /schema-explorer/api/schemas',
      controller: 'SchemaExplorerController',
      method: 'schemas',
    });
    inv.nodes.push({
      id: 's9',
      name: 'SchemaNodeList',
      bound: false,
      jsonSchema: {type: 'array'},
      usages: [
        {
          surface: 'rest',
          role: 'response',
          ref: 'GET /schema-explorer/api/schemas',
          surfaceId: 'rest::GET /schema-explorer/api/schemas',
          controller: 'SchemaExplorerController',
          method: 'schemas',
        },
      ],
    });
    inv.edges.push({
      from: 's9',
      to: 'rest::GET /schema-explorer/api/schemas',
      role: 'response',
      surface: 'rest',
    });

    const paths = inventoryToOkf(inv).files.map(f => f.path);
    // The app's own schema + surfaces stay …
    expect(paths).toContain('schemas/user.md');
    expect(paths).toContain('surfaces/rest-post-users.md');
    // … but the explorer's self-referential surface + node are gone.
    expect(paths).not.toContain('schemas/schemanodelist.md');
    expect(paths.some(p => p.includes('schema-explorer'))).toBe(false);
  });

  it('honors a custom exclude predicate', () => {
    const inv = userInventory();
    // Exclude the MCP surface; the User node keeps only its REST usage.
    const bundle = inventoryToOkf(inv, {
      exclude: s => s.surface === 'mcp',
    });
    const paths = bundle.files.map(f => f.path);
    expect(paths).toContain('surfaces/rest-post-users.md');
    expect(paths).not.toContain('surfaces/mcp-create-user.md');
    const user = bundle.files.find(f => f.path === 'schemas/user.md')!;
    expect(user.content).toContain('rest `response`');
    expect(user.content).not.toContain('mcp `output`');
  });

  it('emits a reference doc per surface that links back to its schemas', () => {
    const doc = file(inventoryToOkf(userInventory()), 'surfaces/rest-post-users.md');
    expect(doc).toContain('type: reference');
    expect(doc).toContain('POST /users');
    expect(doc).toContain('UserController.create');
    // Back-link to the schema tier.
    expect(doc).toContain('../schemas/user.md');
  });
});
