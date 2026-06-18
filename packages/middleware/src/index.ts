// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Runtime-neutral middleware machinery shared by `@agentback/rest` and the
 * `@agentback/express` host. This package has NO Express runtime dependency
 * (express appears only in type positions), so its barrel is edge-safe — an
 * `EdgeRestApplication` / Cloudflare Workers app can import from it without
 * pulling Express into the bundle OR the install tree.
 *
 * @packageDocumentation
 */
// Order matters: `keys` before `types` — they form an init cycle
// (keys imports MiddlewareGroups from types; types imports MiddlewareBindings
// from keys), and evaluating `keys` first is the order that resolves it (matches
// the original @agentback/express barrel). Reversing it leaves
// MiddlewareGroups undefined when keys reads MiddlewareGroups.DEFAULT.
export * from './keys.js';
export * from './types.js';
export * from './group-sorter.js';
export * from './middleware.js';
export * from './middleware-interceptor.js';
export * from './middleware-registry.js';
export * from './mixins/middleware.mixin.js';
export * from './providers/invoke-middleware.provider.js';
export * from './express-service.interface.js';
export * from './express-service-keys.js';
