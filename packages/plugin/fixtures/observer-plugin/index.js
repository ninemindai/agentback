// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';

// Module-scoped, so every mount in a process shares these arrays (ESM
// evaluates the fixture once). Tests reset them before asserting.
const stops = [];
const starts = [];

export class RecordingObserver {
  async start() {
    starts.push('observer-plugin');
  }
  async stop() {
    stops.push('observer-plugin');
  }
}

export class ObserverComponent {
  constructor() {
    this.lifeCycleObservers = [RecordingObserver];
    this.bindings = [
      Binding.bind('test.observerStops').to(stops),
      Binding.bind('test.observerStarts').to(starts),
    ];
  }
}
