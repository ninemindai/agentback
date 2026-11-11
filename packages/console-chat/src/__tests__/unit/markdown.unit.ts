// Copyright Zhaohui Feng 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Unit tests for the `parseMarkdown` and `parseInline` pure functions in
 * `src/client/markdown.tsx`.  No DOM or React involved.
 */

import {describe, it, expect} from 'vitest';
import {
  parseMarkdown,
  parseInline,
  isSafeHref,
} from '../../client/markdown-parser.js';

// ---------------------------------------------------------------------------
// parseInline
// ---------------------------------------------------------------------------

describe('parseInline', () => {
  it('returns plain text for a line with no markup', () => {
    const spans = parseInline('hello world');
    expect(spans).toEqual([{kind: 'text', text: 'hello world'}]);
  });

  it('recognises inline code', () => {
    const spans = parseInline('run `npm install` now');
    expect(spans).toMatchObject([
      {kind: 'text', text: 'run '},
      {kind: 'code', text: 'npm install'},
      {kind: 'text', text: ' now'},
    ]);
  });

  it('recognises **bold**', () => {
    const spans = parseInline('this is **important** text');
    expect(spans).toMatchObject([
      {kind: 'text', text: 'this is '},
      {kind: 'bold', text: 'important'},
      {kind: 'text', text: ' text'},
    ]);
  });

  it('recognises *italic*', () => {
    const spans = parseInline('maybe *try* this');
    expect(spans).toMatchObject([
      {kind: 'text', text: 'maybe '},
      {kind: 'italic', text: 'try'},
      {kind: 'text', text: ' this'},
    ]);
  });

  it('recognises [link](href)', () => {
    const spans = parseInline('see [docs](https://example.com) for more');
    expect(spans).toMatchObject([
      {kind: 'text', text: 'see '},
      {kind: 'link', text: 'docs', href: 'https://example.com'},
      {kind: 'text', text: ' for more'},
    ]);
  });

  // Security: link href comes from untrusted agent output. Unsafe schemes must
  // be downgraded to plain text (label kept, NOT a clickable link) so an
  // agent-emitted `[x](javascript:…)` can't run script in the console origin.
  it('downgrades a javascript: link to plain text (no clickable href)', () => {
    const spans = parseInline('click [here](javascript:alert(1)) now');
    // No link span at all; the label survives as text.
    expect(spans.some(s => s.kind === 'link')).toBe(false);
    expect(spans).toContainEqual({kind: 'text', text: 'here'});
  });

  it('downgrades data:/vbscript: links to text', () => {
    expect(
      parseInline('[x](data:text/html,<script>1</script>)').some(
        s => s.kind === 'link',
      ),
    ).toBe(false);
    expect(
      parseInline('[x](vbscript:msgbox)').some(s => s.kind === 'link'),
    ).toBe(false);
  });

  it('keeps safe links (http/https/mailto/relative/anchor) clickable', () => {
    for (const href of [
      'https://ok.com',
      'http://ok.com',
      'mailto:a@b.com',
      '/docs',
      './rel',
      '#anchor',
    ]) {
      const spans = parseInline(`[x](${href})`);
      expect(spans).toContainEqual({kind: 'link', text: 'x', href});
    }
  });
});

describe('isSafeHref', () => {
  it('allows http(s), mailto, relative, anchor', () => {
    for (const h of [
      'https://a',
      'http://a',
      'mailto:a@b',
      '/x',
      './x',
      '../x',
      '#x',
    ])
      expect(isSafeHref(h)).toBe(true);
  });
  it('rejects javascript:/data:/vbscript: and unknown schemes', () => {
    for (const h of [
      'javascript:x',
      'data:x',
      'vbscript:x',
      'file:///etc',
      'ftp://x',
    ])
      expect(isSafeHref(h)).toBe(false);
  });
  it('rejects scheme hidden behind leading control chars / whitespace', () => {
    // Browsers ignore leading control chars when resolving the scheme, so these
    // must be normalized away before the allowlist check and then rejected.
    expect(isSafeHref('\tjavascript:alert(1)')).toBe(false);
    expect(isSafeHref('\n javascript:alert(1)')).toBe(false);
    expect(isSafeHref('\u0000javascript:alert(1)')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseMarkdown — block types
// ---------------------------------------------------------------------------

describe('parseMarkdown — fenced code block', () => {
  it('parses a fenced code block with a language tag', () => {
    const src = '```ts\nconst x = 1;\n```';
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'fenced',
      lang: 'ts',
      body: 'const x = 1;',
    });
  });

  it('parses a fenced code block without a language tag', () => {
    const src = '```\nplain code\n```';
    const blocks = parseMarkdown(src);
    expect(blocks[0]).toMatchObject({
      kind: 'fenced',
      lang: '',
      body: 'plain code',
    });
  });

  it('preserves multi-line fenced body', () => {
    const src = '```\nline1\nline2\n```';
    const blocks = parseMarkdown(src);
    expect(blocks[0]).toMatchObject({kind: 'fenced', body: 'line1\nline2'});
  });
});

describe('parseMarkdown — inline code in paragraph', () => {
  it('produces a paragraph with a code span', () => {
    const blocks = parseMarkdown('Use `pnpm build` first.');
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.kind).toBe('paragraph');
    if (block.kind === 'paragraph') {
      expect(block.spans).toMatchObject([
        {kind: 'text', text: 'Use '},
        {kind: 'code', text: 'pnpm build'},
        {kind: 'text', text: ' first.'},
      ]);
    }
  });
});

describe('parseMarkdown — bold', () => {
  it('produces a bold span inside a paragraph', () => {
    const blocks = parseMarkdown('This is **critical** info.');
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.kind).toBe('paragraph');
    if (block.kind === 'paragraph') {
      expect(block.spans).toMatchObject([
        {kind: 'text', text: 'This is '},
        {kind: 'bold', text: 'critical'},
        {kind: 'text', text: ' info.'},
      ]);
    }
  });
});

describe('parseMarkdown — headings', () => {
  it('parses a level-1 heading', () => {
    const blocks = parseMarkdown('# My Heading');
    expect(blocks[0]).toMatchObject({kind: 'heading', level: 1});
    const b = blocks[0]!;
    if (b.kind === 'heading') {
      expect(b.spans).toMatchObject([{kind: 'text', text: 'My Heading'}]);
    }
  });

  it('parses a level-2 heading', () => {
    const blocks = parseMarkdown('## Sub-heading');
    expect(blocks[0]).toMatchObject({kind: 'heading', level: 2});
  });

  it('parses a level-3 heading', () => {
    const blocks = parseMarkdown('### Details');
    expect(blocks[0]).toMatchObject({kind: 'heading', level: 3});
  });
});

describe('parseMarkdown — bullet list', () => {
  it('parses a - bullet list', () => {
    const src = '- alpha\n- beta\n- gamma';
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.kind).toBe('bullet');
    if (block.kind === 'bullet') {
      expect(block.items).toHaveLength(3);
      expect(block.items[0]).toMatchObject([{kind: 'text', text: 'alpha'}]);
      expect(block.items[2]).toMatchObject([{kind: 'text', text: 'gamma'}]);
    }
  });

  it('parses a * bullet list', () => {
    const src = '* one\n* two';
    const blocks = parseMarkdown(src);
    expect(blocks[0]).toMatchObject({kind: 'bullet'});
    if (blocks[0]?.kind === 'bullet') {
      expect(blocks[0].items).toHaveLength(2);
    }
  });
});

describe('parseMarkdown — ordered list', () => {
  it('parses a numbered list', () => {
    const src = '1. first\n2. second\n3. third';
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(1);
    const block = blocks[0]!;
    expect(block.kind).toBe('ordered');
    if (block.kind === 'ordered') {
      expect(block.items).toHaveLength(3);
      expect(block.items[0]).toMatchObject([{kind: 'text', text: 'first'}]);
    }
  });
});

describe('parseMarkdown — link in paragraph', () => {
  it('produces a link span', () => {
    const blocks = parseMarkdown('Read [the docs](https://agentback.dev).');
    const block = blocks[0]!;
    expect(block.kind).toBe('paragraph');
    if (block.kind === 'paragraph') {
      expect(block.spans).toMatchObject([
        {kind: 'text', text: 'Read '},
        {kind: 'link', text: 'the docs', href: 'https://agentback.dev'},
        {kind: 'text', text: '.'},
      ]);
    }
  });
});

describe('parseMarkdown — fallback / graceful degradation', () => {
  it('emits unknown lines as plain text paragraph — nothing dropped', () => {
    const src = '★ Insight ─────────────────────────\nSome observation here.';
    const blocks = parseMarkdown(src);
    // Both lines appear; neither is silently dropped.
    const allText = blocks
      .flatMap(b => (b.kind === 'paragraph' ? b.spans.map(s => s.text) : []))
      .join('');
    expect(allText).toContain('★ Insight');
    expect(allText).toContain('Some observation here.');
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('does not throw on empty input', () => {
    expect(() => parseMarkdown('')).not.toThrow();
    expect(parseMarkdown('')).toEqual([]);
  });

  it('does not throw on input with only blank lines', () => {
    expect(() => parseMarkdown('\n\n\n')).not.toThrow();
  });

  it('does not throw on ASCII art / box-drawing characters', () => {
    const src = '┌──────┐\n│ box  │\n└──────┘';
    expect(() => parseMarkdown(src)).not.toThrow();
    const blocks = parseMarkdown(src);
    const allText = blocks
      .flatMap(b => (b.kind === 'paragraph' ? b.spans.map(s => s.text) : []))
      .join('');
    expect(allText).toContain('box');
  });

  it('parses a pipe table into a table block with inline cells', () => {
    const src =
      '| Name | Type |\n| --- | --- |\n| `id` | string |\n| age | number |';
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(1);
    const t = blocks[0]!;
    expect(t.kind).toBe('table');
    if (t.kind !== 'table') throw new Error('expected table');
    expect(t.headers.map(c => c.map(s => s.text).join(''))).toEqual([
      'Name',
      'Type',
    ]);
    expect(t.rows).toHaveLength(2);
    // first cell of row 0 is inline `code`, not plain text
    expect(t.rows[0]![0]![0]).toEqual({kind: 'code', text: 'id'});
    expect(t.rows[1]!.map(c => c.map(s => s.text).join(''))).toEqual([
      'age',
      'number',
    ]);
  });

  it('separates a paragraph from a table that immediately follows it', () => {
    const src = 'Here is data:\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const blocks = parseMarkdown(src);
    expect(blocks.map(b => b.kind)).toEqual(['paragraph', 'table']);
  });

  it('a lone pipe line without a separator stays a paragraph', () => {
    const blocks = parseMarkdown('| not | a table |');
    expect(blocks[0]!.kind).toBe('paragraph');
  });
});
