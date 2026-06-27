// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Component} from '@agentback/core';
import {InMemoryActorRuntime} from './in-memory-runtime.js';
import {ActorRegistry} from './registry.js';

/** Bind the actor runtime port to the single-process reference adapter. */
export class InMemoryActorsComponent implements Component {
  services = [InMemoryActorRuntime, ActorRegistry];
}
