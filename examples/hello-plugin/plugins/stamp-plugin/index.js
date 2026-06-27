// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// This package has NO `agentback` marker (see package.json), so loadPlugins
// won't discover it. It's mounted imperatively with
// `loadPlugin(app, './plugins/stamp-plugin', {component: 'StampPlugin'})` —
// the {component} names the export since there's no marker to read it from.

import {Binding} from '@agentback/context';

export class StampPlugin {
  constructor() {
    this.bindings = [
      Binding.bind('plugin.stamp').to(
        '⏱️ from @hello/stamp-plugin (explicitly mounted by loadPlugin)',
      ),
    ];
  }
}
