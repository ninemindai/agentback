// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// A plugin is just a package whose `agentback` marker (see package.json) names
// a Component export. This one contributes a single DI binding the host app's
// controller injects. Marked → `loadPlugins` discovers it automatically.

import {Binding} from '@agentback/context';

export class GreetingPlugin {
  constructor() {
    this.bindings = [
      Binding.bind('plugin.greeting').to(
        '👋 from @hello/greeting-plugin (auto-discovered by loadPlugins)',
      ),
    ];
  }
}
