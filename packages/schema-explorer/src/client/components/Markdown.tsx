// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

// Renders the OKF markdown AST (see ../../lib/markdown) as React. Relative
// `.md` links are intercepted and routed back through `onNavigate` so the
// Knowledge tab navigates the bundle in place (OKF's progressive disclosure);
// any other href opens normally.

import {Fragment} from 'react';
import {parseMarkdown, type MdSpan} from '../../lib/markdown.js';

function isRelativeDoc(href: string): boolean {
  return !/^[a-z]+:\/\//i.test(href) && href.endsWith('.md');
}

function Spans({spans, onNavigate}: {spans: MdSpan[]; onNavigate(href: string): void}) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.kind === 'text') return <Fragment key={i}>{s.text}</Fragment>;
        if (s.kind === 'code') return <code key={i}>{s.text}</code>;
        if (isRelativeDoc(s.href)) {
          return (
            <a
              key={i}
              href={s.href}
              onClick={e => {
                e.preventDefault();
                onNavigate(s.href);
              }}
            >
              {s.text}
            </a>
          );
        }
        return (
          <a key={i} href={s.href} target="_blank" rel="noreferrer">
            {s.text}
          </a>
        );
      })}
    </>
  );
}

export function Markdown({
  source,
  onNavigate,
}: {
  source: string;
  onNavigate(href: string): void;
}) {
  const blocks = parseMarkdown(source);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'frontmatter':
            return (
              <dl className="fm" key={i}>
                {b.entries.map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </Fragment>
                ))}
              </dl>
            );
          case 'heading': {
            const H = `h${Math.min(b.level + 1, 6)}` as 'h2';
            return <H key={i}>{b.text}</H>;
          }
          case 'paragraph':
            return (
              <p key={i}>
                <Spans spans={b.spans} onNavigate={onNavigate} />
              </p>
            );
          case 'list':
            return (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Spans spans={item} onNavigate={onNavigate} />
                  </li>
                ))}
              </ul>
            );
          case 'table':
            return (
              <table key={i}>
                <thead>
                  <tr>
                    {b.headers.map((h, j) => (
                      <th key={j}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((c, k) => (
                        <td key={k}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
        }
      })}
    </div>
  );
}
