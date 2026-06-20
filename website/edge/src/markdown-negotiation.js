// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Markdown content negotiation for agentback.dev.
//
// The site is static (GitHub Pages origin behind Cloudflare), and the build
// already emits an authored `.md` twin next to every HTML page plus an
// `index.md` for the homepage. GitHub Pages can't vary a response on the
// request's `Accept` header, so this Worker — mounted in front of the origin —
// does it: when an agent sends `Accept: text/markdown`, it serves the authored
// markdown twin with `Content-Type: text/markdown`. Everything else falls
// straight through to the origin unchanged.
//
// Fail-safe by design: any error, or any path without a markdown twin, returns
// the origin response. The Worker fronts the whole site, so it must never be
// able to break it.

/**
 * Map a request path to its authored markdown twin, or null if the path is not
 * a negotiable HTML document (assets, already-markdown, etc.).
 * @param {string} pathname
 * @returns {string | null}
 */
export function markdownTwin(pathname) {
  let p = pathname;
  if (p === '/') return '/index.md';
  if (p.endsWith('/')) p += 'index.html'; // directory → its index document
  if (p.endsWith('.html')) return `${p.slice(0, -'.html'.length)}.md`;
  // Extensionless paths are served by GitHub Pages as `<path>.html`.
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (!last.includes('.')) return `${p}.md`;
  return null; // has a non-HTML extension (.png, .css, .json, …)
}

async function serveMarkdown(request) {
  const url = new URL(request.url);
  const twin = markdownTwin(url.pathname);
  if (!twin) return null;

  const twinUrl = new URL(url);
  twinUrl.pathname = twin;
  twinUrl.search = '';

  // Subrequest to the same zone is routed to the origin, not back to us.
  const origin = await fetch(twinUrl.toString(), {
    headers: {Accept: 'text/plain, */*'},
  });
  if (!origin.ok) return null; // no twin on disk → let the HTML serve

  const headers = new Headers();
  headers.set('Content-Type', 'text/markdown; charset=utf-8');
  headers.set('Vary', 'Accept');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.set('X-Content-Negotiation', 'agentback-markdown');
  return new Response(origin.body, {status: 200, headers});
}

export default {
  async fetch(request) {
    try {
      if (request.method === 'GET') {
        const accept = (request.headers.get('Accept') || '').toLowerCase();
        if (accept.includes('text/markdown')) {
          const md = await serveMarkdown(request);
          if (md) return md;
        }
      }
    } catch {
      // Never let negotiation break the site — fall through to origin.
    }
    return fetch(request);
  },
};
