// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: agentback website
// This file is licensed under the MIT License.

// Builds the agentback.dev static site into website/dist:
//   /                  hand-written homepage (website/index.html)
//   /docs/**           docs/*.md rendered to HTML in a shared shell
//   /blog/**           docs/blog copied verbatim, repo links rewritten
// Markdown stays the single source of truth — nothing is duplicated here.

import {marked} from 'marked';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'website', 'dist');
const GITHUB = 'https://github.com/ninemindai/agentback';
const DOMAIN = 'agentback.dev';

// Markdown sources, repo-relative. Each becomes docs/<path>.html.
const DOC_PAGES = [
  'docs/README.md',
  'docs/concepts/dependency-injection.md',
  'docs/concepts/schema-first-decorators.md',
  'docs/concepts/components-servers-lifecycle.md',
  'docs/guides/build-a-rest-api.md',
  'docs/guides/build-an-mcp-server.md',
  'docs/guides/build-a-hybrid-app.md',
  'docs/guides/composition-and-extensibility.md',
  'docs/guides/testing.md',
  'docs/guides/secure-mcp-over-http.md',
  'docs/guides/deploy-to-production.md',
  'docs/architecture/overview.md',
  'docs/architecture/metering-and-payments.md',
  'docs/agent-ergonomics.md',
  'docs/db-story.md',
];

const NAV_SECTIONS = [
  {
    title: 'Start',
    items: [['docs/README.md', 'Documentation index']],
  },
  {
    title: 'Concepts',
    items: [
      ['docs/concepts/dependency-injection.md', 'Dependency injection'],
      ['docs/concepts/schema-first-decorators.md', 'Schema-first decorators'],
      [
        'docs/concepts/components-servers-lifecycle.md',
        'Components, servers & lifecycle',
      ],
    ],
  },
  {
    title: 'Guides',
    items: [
      ['docs/guides/build-a-rest-api.md', 'Build a REST API'],
      ['docs/guides/build-an-mcp-server.md', 'Build an MCP server'],
      ['docs/guides/build-a-hybrid-app.md', 'Build a hybrid app'],
      [
        'docs/guides/composition-and-extensibility.md',
        'Composition & extensibility',
      ],
      ['docs/guides/testing.md', 'Testing'],
      ['docs/guides/secure-mcp-over-http.md', 'Secure MCP over HTTP'],
      ['docs/guides/deploy-to-production.md', 'Deploy to production'],
    ],
  },
  {
    title: 'Architecture',
    items: [
      ['docs/architecture/overview.md', 'Overview'],
      ['docs/architecture/metering-and-payments.md', 'Metering & payments'],
    ],
  },
  {
    title: 'Design',
    items: [
      ['docs/agent-ergonomics.md', 'Boundary coherence thesis'],
      ['docs/db-story.md', 'Database story'],
    ],
  },
];

/** Map a repo-relative path to its output path on the site (or external URL). */
function mapTarget(repoPath) {
  const p = repoPath.replace(/\\/g, '/');
  if (p === 'docs/README.md') return 'docs/index.html';
  const blog = p.match(/^docs\/blog\/(.*)$/);
  if (blog) return `blog/${blog[1]}`;
  const md = p.match(/^docs\/(.+)\.md$/);
  if (md && DOC_PAGES.includes(p)) return `docs/${md[1]}.html`;
  if (/^docs\/.+\.html$/.test(p)) return p; // copied diagrams
  // Everything else (root README, packages/, examples/, proposals/…) → GitHub.
  const lastSeg = p.split('/').pop();
  const kind = lastSeg.includes('.') ? 'blob' : 'tree';
  return `${GITHUB}/${kind}/main/${p}`;
}

/** Rewrite one href found in a file at repo dir `srcDir`, for an output page at `outPage`. */
function rewriteHref(href, srcDir, outPage) {
  if (/^(https?:|mailto:|#|data:)/.test(href)) return href;
  const [target, anchor] = href.split('#');
  if (!target) return href;
  const resolved = path.posix.normalize(path.posix.join(srcDir, target));
  const mapped = mapTarget(resolved);
  const suffix = anchor ? `#${anchor}` : '';
  if (/^https?:/.test(mapped)) return mapped + suffix;
  const rel = path.posix.relative(path.posix.dirname(outPage), mapped);
  return (rel || '.') + suffix;
}

function rewriteHtmlLinks(html, srcDir, outPage) {
  return html.replace(
    /href="([^"]+)"/g,
    (_, href) => `href="${rewriteHref(href, srcDir, outPage)}"`,
  );
}

/** GitHub-style heading slugs so cross-doc #anchors keep working. */
function slugify(text, used) {
  const base = text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '')
    .replace(/&[a-z]+;/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function addHeadingIds(html) {
  const used = new Map();
  return html.replace(
    /<h([1-4])>([\s\S]*?)<\/h\1>/g,
    (_, level, inner) =>
      `<h${level} id="${slugify(inner, used)}">${inner}</h${level}>`,
  );
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function docShell({title, body, outPage}) {
  const rel = p => path.posix.relative(path.posix.dirname(outPage), p) || '.';
  const nav = NAV_SECTIONS.map(section => {
    const items = section.items
      .map(([src, label]) => {
        const target = mapTarget(src);
        const current = target === outPage ? ' aria-current="page"' : '';
        return `<a href="${rel(target)}"${current}>${escapeHtml(label)}</a>`;
      })
      .join('\n          ');
    return `<div class="nav-group">\n          <h2>${section.title}</h2>\n          ${items}\n        </div>`;
  }).join('\n        ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · AgentBack</title>
    <meta name="description" content="AgentBack documentation — ${escapeHtml(title)}" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,640&family=Inter:wght@400;550;700&family=JetBrains+Mono:wght@400;600&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="${rel('styles.css')}" />
  </head>
  <body class="doc-page">
    <header class="site-header">
      <nav class="nav" aria-label="Primary">
        <a class="brand" href="${rel('index.html')}">AgentBack<span class="brand-dot">.dev</span></a>
        <div class="nav-links">
          <a href="${rel('docs/index.html')}">Docs</a>
          <a href="${rel('blog/index.html')}">Blog</a>
          <a href="${GITHUB}">GitHub</a>
        </div>
      </nav>
    </header>
    <div class="doc-layout">
      <aside class="doc-nav" aria-label="Documentation">
        ${nav}
      </aside>
      <main class="doc-content">
${body}
        <footer class="doc-footer">
          <p>
            MIT licensed · <a href="${GITHUB}">ninemindai/agentback</a> ·
            built from the markdown in <a href="${GITHUB}/tree/main/docs">docs/</a>
          </p>
        </footer>
      </main>
    </div>
  </body>
</html>
`;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, {recursive: true});
  for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function write(outPage, content) {
  const file = path.join(out, outPage);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content);
}

// ---- build ----------------------------------------------------------------

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

// 1. Homepage + shared assets.
for (const asset of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(root, 'website', asset), path.join(out, asset));
}
write('CNAME', `${DOMAIN}\n`);
write('.nojekyll', '');

// 2. Docs: markdown → HTML in the doc shell.
marked.setOptions({gfm: true});
for (const src of DOC_PAGES) {
  const md = fs.readFileSync(path.join(root, src), 'utf8');
  const outPage = mapTarget(src);
  const title = (md.match(/^#\s+(.+)$/m) ?? [, src])[1].replace(/[*_`]/g, '');
  let body = marked.parse(md);
  body = addHeadingIds(body);
  body = rewriteHtmlLinks(body, path.posix.dirname(src), outPage);
  write(outPage, docShell({title, body, outPage}));
}

// 3. Architecture diagrams: standalone HTML, copied verbatim.
const diagrams = path.join(root, 'docs', 'architecture', 'diagrams');
if (fs.existsSync(diagrams)) {
  copyDir(diagrams, path.join(out, 'docs', 'architecture', 'diagrams'));
}

// 4. Blog: copy, then rewrite repo-relative links in the HTML files.
copyDir(path.join(root, 'docs', 'blog'), path.join(out, 'blog'));
const rewriteBlogDir = dir => {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteBlogDir(file);
    } else if (entry.name.endsWith('.html')) {
      const outPage = path.posix.join(
        'blog',
        path.relative(path.join(out, 'blog'), file).replace(/\\/g, '/'),
      );
      const srcDir = path.posix.dirname(path.posix.join('docs', outPage));
      fs.writeFileSync(
        file,
        rewriteHtmlLinks(fs.readFileSync(file, 'utf8'), srcDir, outPage),
      );
    }
  }
};
rewriteBlogDir(path.join(out, 'blog'));

// 5. Cache busting: stamp every stylesheet href with a content hash so a
// deploy is never masked by a stale browser/CDN copy of styles.css.
const cssVersions = new Map();
const versionFor = file => {
  if (!cssVersions.has(file)) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file));
    cssVersions.set(file, hash.digest('hex').slice(0, 8));
  }
  return cssVersions.get(file);
};
const stampStylesheets = dir => {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      stampStylesheets(file);
    } else if (entry.name.endsWith('.html')) {
      const html = fs
        .readFileSync(file, 'utf8')
        .replace(/href="([^"?]*styles\.css)"/g, (whole, href) => {
          const target = path.resolve(path.dirname(file), href);
          if (!fs.existsSync(target)) return whole;
          return `href="${href}?v=${versionFor(target)}"`;
        });
      fs.writeFileSync(file, html);
    }
  }
};
stampStylesheets(out);

const count = DOC_PAGES.length;
console.log(
  `built website/dist — homepage, ${count} docs pages, blog, diagrams`,
);
