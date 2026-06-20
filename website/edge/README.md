# agentback.dev edge Worker

A Cloudflare Worker that **serves agentback.dev from Workers Static Assets** and
adds **markdown content negotiation**.

## What it does

`website/build.mjs` builds the site into `website/dist` and emits an authored
markdown twin next to every page:

- every docs page → `…/<page>.md`
- the homepage → `/index.md`
- plus `/llms.txt` and `/llms-full.txt`

`wrangler deploy` uploads `dist` as this Worker's static asset set (the `ASSETS`
binding). The Worker serves those assets directly at the edge and, on a request
with `Accept: text/markdown`, returns the authored twin instead of the HTML — a
local asset lookup, no origin, no second hop.

```
GET /docs/guides/build-a-rest-api    Accept: text/html       → HTML  (asset)
GET /docs/guides/build-a-rest-api    Accept: text/markdown   → .md   (negotiated)
GET /                                 Accept: text/markdown   → /index.md
```

Fail-safe: any error, or any path without a twin, serves the normal asset.

## Why this replaced the GitHub-Pages proxy

The prior design kept GitHub Pages as the origin and put a Worker in front to
proxy + negotiate. That meant two cert systems, a CF→GitHub second hop, and a
cross-origin fetch back to GitHub on every markdown request. Serving from
`ASSETS` collapses all of that into one platform: one cert, one hop, twins read
locally. It's also the natural home for the remaining edge-only agent-readiness
signals (Link headers, Web Bot Auth).

## Cutover (deliberate, reversible, no DNS change)

The Worker keeps the existing `agentback.dev/*` route. Deploying the
assets-based Worker on that route makes it serve `dist` and short-circuit before
the proxied GitHub origin is ever reached — so **no DNS record changes**, and a
rollback is just redeploying the previous proxy Worker.

1. Create a Cloudflare API token (My Profile → API Tokens) with **Account →
   Workers Scripts → Edit** (and Workers R2/KV as needed). Add it to the repo as
   the **`CLOUDFLARE_API_TOKEN`** secret.
2. Deploy — either locally from this directory:
   ```bash
   npx wrangler deploy           # uploads dist + the Worker on agentback.dev/*
   npx wrangler deploy --dry-run # validate config + bundle without publishing
   ```
   …or trigger the **Deploy Worker (Cloudflare)** GitHub Action
   (`workflow_dispatch`).
3. Verify:
   ```bash
   curl -s -H 'Accept: text/markdown' "https://agentback.dev/" \
     -o /dev/null -w '%{content_type}\n'      # → text/markdown; charset=utf-8
   curl -s "https://agentback.dev/" -o /dev/null -w '%{content_type}\n'  # → text/html
   curl -sI "https://agentback.dev/" | grep -i cf-ray   # still proxied
   ```
4. Once confirmed: switch `.github/workflows/deploy-worker.yml` to `on: push`
   (paths: `website/**`) and **retire `.github/workflows/pages.yml`** — GitHub
   Pages is no longer the origin (assets are uploaded to Cloudflare on deploy).

## Notes

- The zone must be active and **proxied (orange-cloud)** in the account — a
  Worker only runs on traffic through Cloudflare's proxy. (Already the case.)
- `account_id` is in `wrangler.toml`; it is not a secret.
- The route stays `agentback.dev/*` (full-site). A path-scoped route can't
  reliably cover the homepage because Cloudflare route matching is
  query-sensitive — only a `*` wildcard matches a cache-busted `/?…` URL.
