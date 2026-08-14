// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * A plugin whose Component contributes a REST controller.
 *
 * Authored in TypeScript (rather than under `fixtures/`, which is plain JS)
 * because the route decorators need to compile. `loadPlugin` accepts a bare
 * file path with an explicit `{component}`, so this needs no package marker.
 * Vitest excludes `dist/**\/__tests__/fixtures/**`, so it is never collected
 * as a test.
 */

import type {Component} from '@agentback/core';
import {api, get} from '@agentback/openapi';

@api({basePath: '/'})
class PluginController {
  @get('/plugin-ping')
  async ping() {
    return {ok: true};
  }
}

export class RouteComponent implements Component {
  controllers = [PluginController];
}
