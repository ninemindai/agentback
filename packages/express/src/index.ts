// Copyright NineMind, Inc. 2026. All Rights Reserved.
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
// The neutral middleware machinery moved to @agentback/middleware. Re-exported
// here so existing `import {MiddlewareMixin, MiddlewareGroups, ...} from
// '@agentback/express'` keeps working (back-compat). New code may import these
// from @agentback/middleware directly.
export * from '@agentback/middleware';
// The Express host modules (value-import express; Node-only).
export * from './express.application.js';
export * from './express.server.js';
export * from './express-component.js';
// `ExpressService` is both the neutral INTERFACE (re-exported from
// @agentback/middleware above) and the concrete CLASS here. The explicit
// named re-export disambiguates the two `export *` sources: `ExpressService`
// from @agentback/express is the class (which implements the interface).
export {ExpressService} from './express-service.js';
// Runtime value re-export: preserves `import {Router} from '@agentback/express'`
// for Node consumers who build Express routers. The barrel is Node-only.
export {Router} from 'express';
