// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// An observer whose stop() rejects. Retraction must still complete: the
// refcounts were already decremented before observers run, so bailing out
// would leave the bindings mounted with no record of who owns them.

import {Binding} from '@agentback/context';

export class ExplodingObserver {
  async stop() {
    throw new Error('stop() exploded');
  }
}

export class BadObserverComponent {
  constructor() {
    this.lifeCycleObservers = [ExplodingObserver];
    this.bindings = [Binding.bind('plugin.badObserverMarker').to('present')];
  }
}
