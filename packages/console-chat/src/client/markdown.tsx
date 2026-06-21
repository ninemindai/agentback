// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * React renderer for the agent chat dock markdown.
 * Parser lives in markdown-parser.ts (no JSX, testable standalone).
 */

import {Fragment} from 'react';
import {parseMarkdown} from './markdown-parser.js';
import type {MdInline} from './markdown-parser.js';

// ---------------------------------------------------------------------------
// Inline renderer
// ---------------------------------------------------------------------------

function InlineSpans({spans}: {spans: MdInline[]}) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.kind) {
          case 'text':
            if (s.text === '\n') return <br key={i} />;
            return <Fragment key={i}>{s.text}</Fragment>;
          case 'code':
            return <code key={i}>{s.text}</code>;
          case 'bold':
            return <strong key={i}>{s.text}</strong>;
          case 'italic':
            return <em key={i}>{s.text}</em>;
          case 'link':
            return (
              <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
                {s.text}
              </a>
            );
        }
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Block renderer
// ---------------------------------------------------------------------------

export function Markdown({source}: {source: string}) {
  const blocks = parseMarkdown(source);
  return (
    <div className="md-chat">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'fenced':
            return (
              <pre key={i} className="md-pre">
                <code className={b.lang ? `language-${b.lang}` : undefined}>
                  {b.body}
                </code>
              </pre>
            );
          case 'heading': {
            const level = Math.min(b.level, 3) as 1 | 2 | 3;
            const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
            return (
              <Tag key={i} className="md-h">
                <InlineSpans spans={b.spans} />
              </Tag>
            );
          }
          case 'bullet':
            return (
              <ul key={i} className="md-ul">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineSpans spans={item} />
                  </li>
                ))}
              </ul>
            );
          case 'ordered':
            return (
              <ol key={i} className="md-ol">
                {b.items.map((item, j) => (
                  <li key={j}>
                    <InlineSpans spans={item} />
                  </li>
                ))}
              </ol>
            );
          case 'paragraph':
            return (
              <p key={i} className="md-p">
                <InlineSpans spans={b.spans} />
              </p>
            );
        }
      })}
    </div>
  );
}
