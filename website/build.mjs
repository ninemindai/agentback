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

// Cloudflare Web Analytics beacon token. Paste yours from the Cloudflare
// dashboard: Web Analytics → agentback.dev → JS snippet → the "token" value
// inside data-cf-beacon. It's public by design (it ships in every page's
// HTML), so committing it is fine. Leave '' to skip injection (e.g. local
// builds); the CF_WEB_ANALYTICS_TOKEN env var overrides this constant.
const CF_WEB_ANALYTICS_TOKEN =
  process.env.CF_WEB_ANALYTICS_TOKEN || '6428f6554fc647d8b84410a726fc0f6a';

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

// Mermaid blocks in the markdown stay the source of truth; the site renders a
// hand-laid-out SVG per block (website/diagrams/<doc>-<n>.svg, see STYLE.md)
// with the mermaid source kept underneath in a <details>.
const DIAGRAM_DIR = path.join(root, 'website', 'diagrams');

function diagramBase(src) {
  if (src === 'docs/architecture/overview.md') return 'architecture-overview';
  return path.posix.basename(src, '.md');
}

function replaceMermaidBlocks(md, src, outPage) {
  let n = 0;
  return md.replace(/```mermaid\n([\s\S]*?)```/g, (_, source) => {
    n += 1;
    const name = `${diagramBase(src)}-${n}.svg`;
    if (!fs.existsSync(path.join(DIAGRAM_DIR, name))) {
      throw new Error(
        `${src} mermaid block #${n} has no rendered SVG at ` +
          `website/diagrams/${name} — create or update it ` +
          `(see website/diagrams/STYLE.md).`,
      );
    }
    const rel = path.posix.relative(
      path.posix.dirname(outPage),
      `diagrams/${name}`,
    );
    // No blank lines inside: marked treats this as one raw HTML block.
    const pre = escapeHtml(source.trim()).replace(/\n{2,}/g, '\n');
    return [
      '<figure class="diagram">',
      `<img src="${rel}" alt="Architecture diagram — text source below" />`,
      '<details>',
      '<summary>diagram source (mermaid)</summary>',
      `<pre><code>${pre}</code></pre>`,
      '</details>',
      '</figure>',
    ].join('\n');
  });
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

  const mdHref = `./${path.posix.basename(outPage, '.html')}.md`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · AgentBack</title>
    <meta name="description" content="AgentBack documentation — ${escapeHtml(title)}" />
    <link rel="alternate" type="text/markdown" href="${mdHref}" />
    <link rel="icon" type="image/png" href="${rel('logo.png')}" />
    <link rel="apple-touch-icon" href="${rel('apple-touch-icon.png')}" />
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
        <a class="brand" href="${rel('index.html')}"><img class="brand-mark" src="${rel('logo-mark.png')}" alt="" />AgentBack<span class="brand-dot">.dev</span></a>
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
            built from the markdown in <a href="${GITHUB}/tree/main/docs">docs/</a> ·
            <a href="${mdHref}">view as markdown</a> ·
            <a href="${rel('llms.txt')}">llms.txt</a>
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
for (const asset of [
  'index.html',
  'styles.css',
  'logo.png',
  'logo-mark.png',
  'apple-touch-icon.png',
  'banner.png',
]) {
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
  let body = marked.parse(replaceMermaidBlocks(md, src, outPage));
  body = addHeadingIds(body);
  body = rewriteHtmlLinks(body, path.posix.dirname(src), outPage);
  write(outPage, docShell({title, body, outPage}));
}

// 2a. Agent-facing artifacts: markdown mirrors of every docs page (served
// next to the HTML), /llms.txt (annotated site map), /llms-full.txt (the
// whole docs corpus in one fetch), and the agent skill at /skills/agentback.
const SITE = `https://${DOMAIN}`;
const docMeta = [];
for (const src of DOC_PAGES) {
  const md = fs.readFileSync(path.join(root, src), 'utf8');
  const outPage = mapTarget(src);
  const mdPage = outPage.replace(/\.html$/, '.md');
  write(mdPage, md);
  const title = (md.match(/^#\s+(.+)$/m) ?? [, src])[1].replace(/[*_`]/g, '');
  const firstPara = (
    md
      .replace(/^---[\s\S]*?---/, '')
      .split(/\n\n+/)
      .map(p => p.trim())
      .find(p => p && !/^[#>|`\-!\[]/.test(p)) ?? ''
  )
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  docMeta.push({src, mdPage, title, firstPara});
}

const llmsSections = NAV_SECTIONS.map(section => {
  const lines = section.items.map(([src, label]) => {
    const m = docMeta.find(d => d.src === src);
    return `- [${label}](${SITE}/${m.mdPage}): ${m.firstPara}`;
  });
  return `## ${section.title}\n\n${lines.join('\n')}`;
});
write(
  'llms.txt',
  `# AgentBack

> AgentBack is an AI-native API/MCP framework for TypeScript: REST endpoints,
> MCP tools, OpenAPI 3.1 docs, typed clients, tests, and runtime validation
> all share one Zod contract, on an ESM port of LoopBack 4's DI core.
> Alpha. MIT. Source: ${GITHUB}

Every page below is the raw markdown the HTML docs are built from.
The full corpus in one file: ${SITE}/llms-full.txt

${llmsSections.join('\n\n')}

## Coding-agent skill

- [SKILL.md](${SITE}/skills/agentback/SKILL.md): teaches an agent the
  decorator patterns, slot-0 input bundle, DI, auth, and client conventions.
  Install: \`npx skills add ninemindai/agentback\`

## Blog

- [Blog index](${SITE}/blog/index.html): design notes — boundary coherence,
  errors agents can fix, tool-surface budgets, per-call pricing, schema-shared
  clients.
`,
);

write(
  'llms-full.txt',
  `# AgentBack — full documentation corpus\n# Source: ${GITHUB} · Site: ${SITE}\n\n` +
    docMeta
      .map(
        d =>
          `\n\n<!-- ===== ${SITE}/${d.mdPage} ===== -->\n\n${fs.readFileSync(path.join(root, d.src), 'utf8')}`,
      )
      .join(''),
);

copyDir(
  path.join(root, 'skills', 'agentback'),
  path.join(out, 'skills', 'agentback'),
);

// 2b. Doc diagram SVGs.
fs.mkdirSync(path.join(out, 'diagrams'), {recursive: true});
for (const f of fs.readdirSync(DIAGRAM_DIR)) {
  if (f.endsWith('.svg')) {
    fs.copyFileSync(path.join(DIAGRAM_DIR, f), path.join(out, 'diagrams', f));
  }
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

// 6. Cloudflare Web Analytics: inject the beacon into every page (homepage,
// generated docs, copied blog) in one post-build pass — same shape as the
// cache-busting walk above. The token is public, so it's safe in the markup.
if (CF_WEB_ANALYTICS_TOKEN) {
  const beacon =
    `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
    `data-cf-beacon='{"token":"${CF_WEB_ANALYTICS_TOKEN}"}'></script>`;
  const injectBeacon = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        injectBeacon(file);
      } else if (entry.name.endsWith('.html')) {
        const html = fs.readFileSync(file, 'utf8');
        if (html.includes('cloudflareinsights.com')) continue; // idempotent
        fs.writeFileSync(file, html.replace('</head>', `  ${beacon}\n  </head>`));
      }
    }
  };
  injectBeacon(out);
}

const count = DOC_PAGES.length;
console.log(
  `built website/dist — homepage, ${count} docs pages, blog, diagrams`,
);
