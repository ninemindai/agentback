# hello-oauth2

> OAuth2-protected REST end-to-end: opaque bearer tokens validated via RFC 7662 introspection, user vs. client-credentials principals, and scope enforcement.

`OAuth2AuthenticationComponent` (from `@agentback/authentication-oauth2`) is
authorization-server agnostic — bring your own AS. For a self-contained demo
this example stands in a tiny **in-process** authorization server via the
`OAuth2Bindings.FETCH` seam, so no external AS or network is needed. In
production you drop the FETCH override and point
`OAuth2Bindings.CONFIG.introspectionUrl` at your real AS (Keycloak, Okta, …);
the resource-server code is identical.

Routes show the progression: `GET /` (who am I), `POST /` (write scope
required via `requireScopes`), `GET /usage` (client-credentials only).

## Run

```bash
pnpm build              # from the repo root
pnpm -F hello-oauth2 start
```

The startup log prints demo bearer tokens to curl with; `/explorer/` serves
Swagger UI.
