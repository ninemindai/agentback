// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';

const stops = [];

export class RecordingObserver {
  async stop() {
    stops.push('observer-plugin');
  }
}

export class ObserverComponent {
  constructor() {
    this.lifeCycleObservers = [RecordingObserver];
    this.bindings = [Binding.bind('test.observerStops').to(stops)];
  }
}
