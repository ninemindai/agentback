// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

// A tiny, dependency-free parser for the exact Markdown subset the OKF emitter
// produces (see ./okf renderers): YAML frontmatter, ATX headings, GFM tables,
// `-` bullet lists, and paragraphs — with inline `[label](href)` links and
// `` `code` `` spans. It returns a small block AST so the React viewer can
// render it (and rewrite relative `.md` links into in-app navigation) without
// pulling in a Markdown library.

export type MdSpan =
  | {kind: 'text'; text: string}
  | {kind: 'code'; text: string}
  | {kind: 'link'; text: string; href: string};

export type MdBlock =
  | {kind: 'frontmatter'; entries: [string, string][]}
  | {kind: 'heading'; level: number; text: string}
  | {kind: 'paragraph'; spans: MdSpan[]}
  | {kind: 'list'; items: MdSpan[][]}
  | {kind: 'table'; headers: string[]; rows: string[][]};

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  // Frontmatter: a leading `---` fence up to the next `---`.
  if (lines[0]?.trim() === '---') {
    const entries: [string, string][] = [];
    i = 1;
    for (; i < lines.length && lines[i]!.trim() !== '---'; i++) {
      const m = /^([^:]+):\s*(.*)$/.exec(lines[i]!);
      if (m) entries.push([m[1]!.trim(), m[2]!.trim()]);
    }
    i++; // skip the closing fence
    blocks.push({kind: 'frontmatter', entries});
  }

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;

    // Heading: `#`..`######` followed by a space.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({kind: 'heading', level: h[1]!.length, text: h[2]!.trim()});
      continue;
    }

    // Table: a `|` row immediately followed by a `| --- |` separator.
    if (isTableRow(line) && isTableSeparator(lines[i + 1])) {
      const headers = splitRow(line);
      const rows: string[][] = [];
      i += 2; // consume header + separator
      for (; i < lines.length && isTableRow(lines[i]!); i++) {
        rows.push(splitRow(lines[i]!));
      }
      i--; // the outer loop will advance past the last consumed row
      blocks.push({kind: 'table', headers, rows});
      continue;
    }

    // List: a run of consecutive `- ` bullets.
    if (/^\s*-\s+/.test(line)) {
      const items: MdSpan[][] = [];
      for (; i < lines.length && /^\s*-\s+/.test(lines[i]!); i++) {
        items.push(parseInline(lines[i]!.replace(/^\s*-\s+/, '')));
      }
      i--;
      blocks.push({kind: 'list', items});
      continue;
    }

    // Otherwise a single-line paragraph (OKF never emits soft-wrapped prose).
    blocks.push({kind: 'paragraph', spans: parseInline(line)});
  }

  return blocks;
}

function isTableRow(line: string | undefined): boolean {
  return !!line && line.trim().startsWith('|');
}

function isTableSeparator(line: string | undefined): boolean {
  return !!line && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

/** Tokenize a single line into text / `code` / [label](href) link spans. */
function parseInline(line: string): MdSpan[] {
  const spans: MdSpan[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) spans.push({kind: 'text', text: line.slice(last, m.index)});
    if (m[1] !== undefined) spans.push({kind: 'code', text: m[1]});
    else spans.push({kind: 'link', text: m[2]!, href: m[3]!});
    last = re.lastIndex;
  }
  if (last < line.length) spans.push({kind: 'text', text: line.slice(last)});
  return spans;
}
