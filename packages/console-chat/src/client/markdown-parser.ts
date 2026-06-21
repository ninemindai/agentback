// Copyright ninemind.ai 2026. All Rights Reserved.
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
  | {kind: 'paragraph'; spans: MdInline[]};

// ---------------------------------------------------------------------------
// Inline parser — bold, italic, inline code, links
// ---------------------------------------------------------------------------

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
      spans.push({kind: 'link', text: m[6], href: m[7]});
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
      !/^\s*\d+\.\s+/.test(lines[i]!)
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
