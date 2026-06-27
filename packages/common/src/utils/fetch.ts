// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The standard Fetch API contract — `typeof globalThis.fetch`.
 *
 * This is the framework's injectable HTTP seam. Domain services that talk to an
 * external API should depend on a {@link Fetch} (bound under
 * `CoreBindings.FETCH`) instead of reaching for the global `fetch`, so tests
 * can supply canned responses with no network:
 *
 * ```ts
 * import {CoreBindings} from '@agentback/core';
 * import {inject} from '@agentback/context';
 * import type {Fetch} from '@agentback/common';
 *
 * class WeatherService {
 *   constructor(
 *     @inject(CoreBindings.FETCH, {optional: true})
 *     private readonly fetch: Fetch = globalThis.fetch,
 *   ) {}
 * }
 * ```
 *
 * Because the type is `globalThis.fetch` itself (not a narrowed structural
 * shape), the injected dependency is a drop-in for global `fetch` — no second
 * source of truth to drift from the platform.
 */
export type Fetch = typeof globalThis.fetch;
