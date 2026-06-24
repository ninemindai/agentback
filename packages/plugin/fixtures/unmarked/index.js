// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export const nothing = true;

// A Component-shaped export with no `agentback` marker in package.json. Used to
// exercise loadPlugin's explicit-`component` path against an unmarked package.
export class UnmarkedComponent {
  constructor() {
    this.bindings = [];
  }
}
