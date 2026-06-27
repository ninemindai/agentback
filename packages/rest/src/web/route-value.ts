// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RouteSchemas} from '@agentback/openapi';

/**
 * What the Router stores per route — everything RestHandler needs to dispatch
 * without re-reading decorator metadata per request. Populated from the route
 * registry in Part 3; built directly in Part 2 tests.
 */
export interface RouteValue {
  ctor: Function;
  methodName: string;
  schemas: RouteSchemas;
  /** Success status (200 default; 201/204/… from the route's `status:`). */
  successStatus: number;
}
