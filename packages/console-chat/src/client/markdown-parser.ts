// Copyright Zhaohui Feng 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Tiny dependency-free markdown parser for the agent chat dock.
 *
 * Produces a block AST from common coding-agent markdown: fenced code blocks,
 * headings, bullet/ordered lists, inline code/bold/italic/links, paragraphs.
 *
 * Pure function; no DOM access; no regex catastrophe.
 * Graceful fallback: unrecognised lines are emitted as plain-text paragraphs —
 * nothing is ever dropped or thrown.
 */

// ---------------------------------------------------------------------------
// Block / inline AST types (exported so the React renderer and tests share them)
// ---------------------------------------------------------------------------

export type MdInline =
  | {kind: 'text'; text: string}
  | {kind: 'code'; text: string}
  | {kind: 'bold'; text: string}
  | {kind: 'italic'; text: string}
  | {kind: 'link'; text: string; href: string};

export type MdBlock =
  | {kind: 'fenced'; lang: string; body: string}
  | {kind: 'heading'; level: number; spans: MdInline[]}
  | {kind: 'bullet'; items: MdInline[][]}
  | {kind: 'ordered'; items: MdInline[][]}
  | {kind: 'table'; headers: MdInline[][]; rows: MdInline[][][]}
  | {kind: 'paragraph'; spans: MdInline[]};

// ---------------------------------------------------------------------------
// Inline parser — bold, italic, inline code, links
// ---------------------------------------------------------------------------

/**
 * Allow only safe link schemes. A link href comes from UNTRUSTED agent output,
 * so an unvalidated `[x](javascript:…)` (or `data:`/`vbscript:`) would be an
 * XSS vector in the console origin. We:
 *   1. strip leading control chars + whitespace (`\u0000`–` `) — browsers
 *      ignore these when resolving the scheme, so `"\tjavascript:…"` would still
 *      execute if we didn't normalize first; and
 *   2. allowlist only http(s), mailto, and relative/anchor links.
 * Everything else (any other scheme, or anything that doesn't match) fails
 * closed: `parseInline` downgrades it to a plain-text span — the label is kept
 * but it is not a clickable link.
 */
export function isSafeHref(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  const normalized = href.replace(/^[\u0000- ]+/, '').toLowerCase();
  return /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/.test(normalized);
}

export function parseInline(line: string): MdInline[] {
  const spans: MdInline[] = [];
  // Priority order: inline code > bold(**/__) > italic(*/_) > link
  // Simple non-greedy stops avoid catastrophic backtracking.
  const re =
    /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![*])\*(?![*])([^*]+)(?<![*])\*(?![*])|(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) {
      spans.push({kind: 'text', text: line.slice(last, m.index)});
    }
    if (m[1] !== undefined) {
      spans.push({kind: 'code', text: m[1]});
    } else if (m[2] !== undefined) {
      spans.push({kind: 'bold', text: m[2]});
    } else if (m[3] !== undefined) {
      spans.push({kind: 'bold', text: m[3]});
    } else if (m[4] !== undefined) {
      spans.push({kind: 'italic', text: m[4]});
    } else if (m[5] !== undefined) {
      spans.push({kind: 'italic', text: m[5]});
    } else if (m[6] !== undefined && m[7] !== undefined) {
      // Downgrade unsafe-scheme links to plain text (keep the label).
      if (isSafeHref(m[7])) {
        spans.push({kind: 'link', text: m[6], href: m[7]});
      } else {
        spans.push({kind: 'text', text: m[6]});
      }
    }
    last = re.lastIndex;
  }
  if (last < line.length) {
    spans.push({kind: 'text', text: line.slice(last)});
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block  ``` [lang]
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        bodyLines.push(lines[i]!);
        i++;
      }
      i++; // consume closing ```
      blocks.push({kind: 'fenced', lang, body: bodyLines.join('\n')});
      continue;
    }

    // Heading  # / ## / ### … ######
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push({
        kind: 'heading',
        level: h[1]!.length,
        spans: parseInline(h[2]!.trim()),
      });
      i++;
      continue;
    }

    // Bullet list  - / *  (collect a consecutive run)
    if (/^\s*[-*]\s+/.test(line)) {
      const items: MdInline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(/^\s*[-*]\s+/, '')));
        i++;
      }
      blocks.push({kind: 'bullet', items});
      continue;
    }

    // Ordered list  1. / 2. …
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: MdInline[][] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(/^\s*\d+\.\s+/, '')));
        i++;
      }
      blocks.push({kind: 'ordered', items});
      continue;
    }

    // Table — a `|` header row immediately followed by a `| --- |` separator.
    // Cells are parsed as inline spans so `code`/bold/links inside them render.
    if (isTableRow(line) && isTableSeparator(lines[i + 1])) {
      const headers = splitRow(line).map(parseInline);
      const rows: MdInline[][][] = [];
      i += 2; // consume header + separator
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i++;
      }
      blocks.push({kind: 'table', headers, rows});
      continue;
    }

    // Blank line — paragraph boundary
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-structural lines.
    // Each source line is joined with a '\n' text span so hard line-breaks
    // are preserved by the renderer (coding agents write one sentence per line).
    const paragraphLines: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      // stop before a table that immediately follows a paragraph (no blank line)
      !(isTableRow(lines[i]!) && isTableSeparator(lines[i + 1]))
    ) {
      paragraphLines.push(lines[i]!);
      i++;
    }
    if (paragraphLines.length > 0) {
      const allSpans: MdInline[] = [];
      for (let j = 0; j < paragraphLines.length; j++) {
        allSpans.push(...parseInline(paragraphLines[j]!));
        if (j < paragraphLines.length - 1) {
          allSpans.push({kind: 'text', text: '\n'});
        }
      }
      blocks.push({kind: 'paragraph', spans: allSpans});
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Table helpers (GitHub-flavored pipe tables; leading/trailing `|` optional-but
// -expected, mirroring the OKF/schema-explorer parser)
// ---------------------------------------------------------------------------

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
