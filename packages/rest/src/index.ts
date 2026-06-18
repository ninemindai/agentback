// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export * from './keys.js';
export * from './types.js';
export * from './errors.js';
export * from './ax.js';
export * from './file-response.js';
export * from './web/router.js';
export * from './web/dispatch.js';
export * from './web/route-value.js';
export * from './web/rest-handler.js';
export * from './web/collect-routes.js';
export * from './web/middleware.js';
export * from './web/cors-middleware.js';
export * from './host/fetch.js';
export * from './host/node.js';
export * from './host/fastify.js';
export * from './host/asset-source.js';
// Named re-exports (not `export *`): `fromDisk`/`serveStaticDir` pull
// `node:fs/promises` (Node-only). esbuild tree-shakes *named* re-exports when
// unused (so a fetch-only worker / an app that never serves disk assets bundles
// edge-clean), but conservatively retains `export *` star re-exports — which
// would drag node:fs onto every worker. A worker that *does* import `fromDisk`
// still pulls node:fs, so the bundle doctor correctly flags it.
export {fromDisk} from './host/asset-source-disk.js';
export {serveStaticDir} from './host/static.js';
export * from './rest.server.js';
export * from './rest.application.js';
