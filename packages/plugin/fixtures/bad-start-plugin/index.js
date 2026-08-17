// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// An observer whose start() rejects. Mounting this into an ALREADY-RUNNING app
// must roll the whole mount back: a half-started plugin holds resources for
// the observers that ran, never ran the rest, and has no inverse yet for the
// caller to retract.

import {Binding} from '@agentback/context';

export class ExplodingStartObserver {
  async start() {
    throw new Error('start() exploded');
  }
}

export class BadStartComponent {
  constructor() {
    this.lifeCycleObservers = [ExplodingStartObserver];
    this.bindings = [Binding.bind('plugin.badStartMarker').to('present')];
  }
}
