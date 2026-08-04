# {{name}}

A Zod-first REST service on [AgentBack](https://agentback.dev).

```bash
npm install
npm run build && npm start      # REST + Swagger UI at /explorer
npm test
```

## Upgrading

```bash
npm run update -- --dry-run   # report what would change, write nothing
npm run update                # bump @agentback/* and run migrations
```

Releases are lockstep, so the migrations for a release ship with it — the
script runs `npx @agentback/cli@latest` rather than a locally installed copy.
