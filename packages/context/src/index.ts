// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Facilities to manage artifacts and their dependencies using {@link Context}
 * in your Node.js applications. It can be used independent of the LoopBack
 * framework.
 *
 * @remarks
 * This package exposes TypeScript/JavaScript APIs and decorators to register
 * artifacts, declare dependencies, and resolve artifacts by keys. The
 * {@link Context} also serves as an IoC container to support dependency
 * injection.
 * Context and Binding are the two core concepts. A context is a registry of
 * bindings and each binding represents a resolvable artifact by the key.
 *
 * - Bindings can be fulfilled by a constant, a factory function, a class, or a
 *   provider.
 * - Bindings can be grouped by tags and searched by tags.
 * - Binding scopes can be used to control how a resolved binding value is
 *   shared.
 * - Bindings can be resolved synchronously or asynchronously.
 * - Provide {@link inject | @inject} and other variants of decorators to
 *   express dependencies.
 * - Support Constructor, property, and method injections.
 * - Allow contexts to form a hierarchy to share or override bindings.
 *
 * @pakageDocumentation
 */

export * from '@agentback/metadata';
export * from './binding.js';
export * from './binding-config.js';
export * from './binding-decorator.js';
export * from './binding-filter.js';
export * from './binding-inspector.js';
export * from './binding-key.js';
export * from './binding-sorter.js';
export * from './context.js';
export * from './context-event.js';
export * from './context-observer.js';
export * from './context-subscription.js';
export * from './context-view.js';
export * from './inject.js';
export * from './inject-config.js';
export * from './interception-proxy.js';
export * from './interceptor.js';
export * from './interceptor-chain.js';
export * from './invocation.js';
export * from './json-types.js';
export * from './keys.js';
export * from './provider.js';
export * from './resolution-session.js';
export * from './resolver.js';
export * from './unique-id.js';
export * from './value-promise.js';
