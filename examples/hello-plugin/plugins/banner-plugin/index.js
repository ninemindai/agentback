// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// This plugin DECLARES its dependency: `inject: ["plugin.greeting"]` in its
// marker (see package.json). Discovery finds it BEFORE greeting-plugin
// (directories are scanned alphabetically), but the declared graph mounts the
// provider first regardless — that ordering is derived, not hand-maintained.

import {Binding} from '@agentback/context';

export class BannerPlugin {
  constructor() {
    this.bindings = [
      Binding.bind('plugin.banner').to(
        '=== hello-plugin (banner-plugin mounted AFTER its provider) ===',
      ),
    ];
  }
}
