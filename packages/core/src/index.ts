// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The core foundation for LoopBack 4. It can also serve as the platform to
 * build large-scale Node.js applications and frameworks.
 *
 * @remarks
 * For examples of how to leverage `@loopback/core` to build composable and
 * extensible projects, check out the
 * {@link https://loopback.io/doc/en/lb4/core-tutorial.html | core tutorial}.
 *
 * @packageDocumentation
 */

// Re-export public Core API coming from dependencies
export * from '@agentback/context';
// Export APIs
export * from './application.js';
export * from './component.js';
export * from './extension-point.js';
export * from './is-main.js';
export * from './keys.js';
export * from './lifecycle.js';
export * from './lifecycle-registry.js';
export * from './mixin-target.js';
export * from './server.js';
export * from './service.js';
