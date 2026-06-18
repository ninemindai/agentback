// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The Express integration package for loopback-next.
 *
 * @remarks
 *
 * This module introduces Koa style cascading middleware that leverage
 * `async/await`. It also enables the ability to plug in existing Express
 * middleware as LoopBack middleware or interceptors so that they can be used at
 * sequence/action, global interceptor, and local interceptor tiers.
 *
 * This module also serves as a standalone extension to Express to provide
 * extensibility and composability for large-scale Express applications by
 * leveraging LoopBack's Dependency Injection and Extension Point/Extension
 * pattern.
 *
 * @packageDocumentation
 */
export * from './express.application.js';
export * from './express.server.js';
export * from './group-sorter.js';
export * from './keys.js';
export * from './middleware.js';
export * from './middleware-interceptor.js';
export * from './middleware-registry.js';
export * from './mixins/middleware.mixin.js';
export * from './providers/invoke-middleware.provider.js';
export * from './types.js';
export * from './express-service.js';
export * from './express-service-keys.js';
export * from './express-component.js';
// Runtime value re-export (types.ts keeps it type-only for the edge subpaths):
// preserves `import {Router} from '@agentback/express'` for Node consumers who
// build Express routers. The barrel is Node-only regardless (express.server above).
export {Router} from 'express';
