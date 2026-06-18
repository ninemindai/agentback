// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';

export class CollideBComponent {
  constructor() {
    this.bindings = [Binding.bind('services.Shared').to('b')];
  }
}
