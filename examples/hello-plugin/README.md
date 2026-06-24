# hello-plugin

The two ways [`@agentback/plugin`](../../packages/plugin/README.md) mounts
`Component`-contributing plugins into an app.

```bash
pnpm -F hello-plugin build   # after a workspace `pnpm build`
pnpm -F hello-plugin start
curl http://127.0.0.1:3000/info
# { "greeting": "👋 from @hello/greeting-plugin ...",
#   "stamp":    "⏱️ from @hello/stamp-plugin ..." }
```

## What it shows

Two tiny plugins live under [`plugins/`](./plugins) as plain-JS packages (they
are **not** workspace members — discovery reads them off disk and imports their
entry module). Each contributes one DI binding that the host's `InfoController`
injects.

| Plugin                   | Marker?                                | Mounted by                                                                                                 |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@hello/greeting-plugin` | yes (`agentback: {plugin, component}`) | `loadPlugins(app, {dirs: ['plugins']})` — **declarative** discovery                                        |
| `@hello/stamp-plugin`    | no                                     | `loadPlugin(app, './plugins/stamp-plugin', {component: 'StampPlugin'})` — **imperative**, names the export |

`loadPlugins` scans the directory and mounts only the **marked** package — the
unmarked one is silently ignored. `loadPlugin` then mounts that unmarked package
explicitly: the target need not be a declared dependency or carry a marker, you
just name its `component`. Both paths share the same fail-closed DI-key
collision governance (a plugin re-binding a key the app already owns throws
unless allow-listed).

## Make your own

Add the marker to any package's `package.json` and `pnpm add` it — `loadPlugins`
will discover it from your declared dependencies (the default `scan: true`):

```jsonc
"agentback": {"plugin": true, "component": "MyComponent"}
```
