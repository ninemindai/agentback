// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {parseMarkdown, type MdBlock} from '../../lib/markdown.js';

/** Find the first block of a given kind (test convenience). */
function first<K extends MdBlock['kind']>(
  blocks: MdBlock[],
  kind: K,
): Extract<MdBlock, {kind: K}> {
  const b = blocks.find(x => x.kind === kind);
  if (!b) throw new Error(`no ${kind} block in ${JSON.stringify(blocks)}`);
  return b as Extract<MdBlock, {kind: K}>;
}

// A representative OKF schema doc — the renderer must handle every shape it
// contains.
const DOC = `---
type: table
tags: [mcp, rest]
---

# User

Backed by Drizzle table \`users\`.

## Fields

| Field | Type | Required |
| --- | --- | --- |
| id | integer | yes |
| createdAt | string (date-time) | yes |

## Used by

- [create_user](../surfaces/mcp-create-user.md) — mcp \`output\`
`;

describe('parseMarkdown', () => {
  it('parses frontmatter into key/value entries', () => {
    const fm = first(parseMarkdown(DOC), 'frontmatter');
    expect(fm.entries).toContainEqual(['type', 'table']);
    expect(fm.entries).toContainEqual(['tags', '[mcp, rest]']);
  });

  it('parses ATX headings with their level', () => {
    const blocks = parseMarkdown(DOC);
    const headings = blocks.filter(b => b.kind === 'heading');
    expect(headings).toContainEqual({kind: 'heading', level: 1, text: 'User'});
    expect(headings).toContainEqual({kind: 'heading', level: 2, text: 'Fields'});
  });

  it('parses a GFM table (header row + body, separator dropped)', () => {
    const table = first(parseMarkdown(DOC), 'table');
    expect(table.headers).toEqual(['Field', 'Type', 'Required']);
    expect(table.rows).toContainEqual(['id', 'integer', 'yes']);
    expect(table.rows).toContainEqual(['createdAt', 'string (date-time)', 'yes']);
    // The `| --- |` separator must not leak in as a data row.
    expect(table.rows.some(r => r[0]?.includes('---'))).toBe(false);
  });

  it('parses a paragraph with an inline code span', () => {
    const para = parseMarkdown(DOC).find(
      b => b.kind === 'paragraph' && b.spans.some(s => s.kind === 'code'),
    );
    expect(para).toBeDefined();
    expect((para as Extract<MdBlock, {kind: 'paragraph'}>).spans).toContainEqual({
      kind: 'code',
      text: 'users',
    });
  });

  it('parses a list item containing a relative link (href preserved verbatim)', () => {
    const list = first(parseMarkdown(DOC), 'list');
    const link = list.items[0]!.find(s => s.kind === 'link');
    expect(link).toEqual({
      kind: 'link',
      text: 'create_user',
      href: '../surfaces/mcp-create-user.md',
    });
  });
});
