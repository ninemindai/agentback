// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

// The "Knowledge" tab: browses the OKF bundle as a file tree + rendered doc,
// with relative cross-links navigating in place. Exports the bundle as a real
// directory-structured `.zip` (client-side, no server packaging) or a single
// concatenated `.md`.

import {useEffect, useMemo, useState} from 'react';
import {useApi} from '../ApiContext';
import type {OkfFile} from '../api';
import {buildZip} from '../../lib/zip.js';
import {Markdown} from './Markdown';

/** Resolve a relative `href` (`../surfaces/x.md`) against the current doc path. */
function resolvePath(from: string, href: string): string {
  const parts = from.includes('/') ? from.split('/').slice(0, -1) : [];
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function download(name: string, data: Uint8Array | string, type: string): void {
  const blob = new Blob([data as BlobPart], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Group bundle paths into a simple two-level tree (root files + directories). */
function tree(files: OkfFile[]): {dir: string; paths: string[]}[] {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const slash = f.path.indexOf('/');
    const dir = slash === -1 ? '' : f.path.slice(0, slash);
    (groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(f.path);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, paths]) => ({dir, paths: paths.sort()}));
}

export function OkfView() {
  const api = useApi();
  const [files, setFiles] = useState<OkfFile[]>([]);
  const [current, setCurrent] = useState('index.md');
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    api.fetchOkf().then(b => setFiles(b.files), e => setError(String(e)));
  }, [api]);

  const byPath = useMemo(() => new Map(files.map(f => [f.path, f])), [files]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? files.filter(f => f.path.toLowerCase().includes(q)) : files;
    return tree(matched);
  }, [files, query]);
  const doc = byPath.get(current);

  if (error) return <div className="err">{error}</div>;
  if (!files.length) return <div className="empty">Loading knowledge bundle…</div>;

  const exportZip = () => {
    download('okf-bundle.zip', buildZip(files), 'application/zip');
    setMenuOpen(false);
  };
  const exportMd = () => {
    const md = files
      .map(f => `<!-- ${f.path} -->\n\n${f.content}`)
      .join('\n\n---\n\n');
    download('okf-bundle.md', md, 'text/markdown');
    setMenuOpen(false);
  };

  return (
    <div className="okf">
      <aside className="okf-tree">
        <div className="okf-export">
          <button className="btn" onClick={() => setMenuOpen(o => !o)}>
            Export ▾
          </button>
          {menuOpen && (
            <div className="okf-menu">
              <button onClick={exportZip}>Download .zip</button>
              <button onClick={exportMd}>Download single .md</button>
            </div>
          )}
        </div>
        <input
          className="filter"
          placeholder="Filter files…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {groups.length === 0 && <div className="okf-dir">No matches</div>}
        {groups.map(g => (
          <div className="okf-group" key={g.dir || '/'}>
            {g.dir && <div className="okf-dir">{g.dir}/</div>}
            {g.paths.map(p => (
              <button
                key={p}
                className={'okf-file' + (p === current ? ' sel' : '')}
                onClick={() => setCurrent(p)}
              >
                {g.dir ? p.slice(g.dir.length + 1) : p}
              </button>
            ))}
          </div>
        ))}
      </aside>
      <div className="okf-doc">
        <div className="okf-docbar">
          <span className="okf-path">{current}</span>
          <button
            className={'btn ghost okf-rawtoggle' + (raw ? ' on' : '')}
            onClick={() => setRaw(r => !r)}
          >
            {raw ? 'Rendered' : 'Raw'}
          </button>
        </div>
        {doc ? (
          raw ? (
            <pre className="okf-raw">{doc.content}</pre>
          ) : (
            <Markdown
              source={doc.content}
              onNavigate={href => {
                const target = resolvePath(current, href);
                if (byPath.has(target)) setCurrent(target);
              }}
            />
          )
        ) : (
          <div className="empty">Not found: {current}</div>
        )}
      </div>
    </div>
  );
}
