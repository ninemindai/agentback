# agentback.dev edge Worker

A single Cloudflare Worker that fronts the GitHub Pages origin for
`agentback.dev` and adds **markdown content negotiation**.

## What it does

GitHub Pages serves files by path and can't vary a response on the request's
`Accept` header. The site build (`website/build.mjs`) already emits an authored
markdown twin next to every page:

- every docs page → `…/<page>.md`
- the homepage → `/index.md`
- plus `/llms.txt` and `/llms-full.txt`

This Worker turns those twins into real negotiation. On a request with
`Accept: text/markdown` it serves the twin with `Content-Type: text/markdown`;
everything else falls through to the origin untouched.

```
GET /docs/guides/build-a-rest-api    Accept: text/html       → HTML (origin)
GET /docs/guides/build-a-rest-api    Accept: text/markdown   → .md  (negotiated)
GET /                                 Accept: text/markdown   → /index.md
```

It is fail-safe: any error, or any path without a twin, returns the origin
response. The Worker fronts the whole site, so it must never break it.

## Deploy

First Worker for this domain. From this directory:

```bash
npx wrangler login           # once, into the account that owns the agentback.dev zone
npx wrangler deploy          # publishes the Worker + its doc routes
```

Validate the bundle without publishing:

```bash
npx wrangler deploy --dry-run
```

After deploy, verify negotiation against the live site:

```bash
curl -s -H 'Accept: text/markdown' -o /dev/null -w '%{content_type}\n' https://agentback.dev/
# → text/markdown; charset=utf-8
curl -s -o /dev/null -w '%{content_type}\n' https://agentback.dev/
# → text/html; charset=utf-8   (browsers/default are unaffected)
```

## Notes

- The routes (`agentback.dev/` and `agentback.dev/docs/*`) require the zone to
  be active and **proxied (orange-cloud)** in the same Cloudflare account — a
  Worker only runs on traffic that flows through Cloudflare's proxy. A DNS-only
  (grey-cloud) record bypasses the edge and the Worker never executes.
- This is also the natural home for the other edge-only agent-readiness
  signals (Link headers, Web Bot Auth) if those get added later.
