// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {AgentPort} from './port.js';
import type {AgentSessionRegistry} from './session-registry.js';

export namespace AgentBindings {
  /**
   * The turn-wrapped agent. Bound TRANSIENT by {@link installAgent}, so a
   * per-request resolution (a controller's `@inject`) yields a wrapper that
   * reads the request's `SecurityBindings.USER` and supplies per-turn
   * identity + metering automatically.
   */
  export const AGENT = BindingKey.create<AgentPort>('agents.agent');
  /**
   * The dev-constructed agent exactly as passed to {@link installAgent} —
   * the escape hatch for options the {@link AgentPort} surface doesn't
   * model. Turns through it are neither identity-attributed nor metered.
   */
  export const RAW_AGENT = BindingKey.create<AgentPort>('agents.agent.raw');
  /** Live-session registry; `app.stop()` destroys everything in it. */
  export const SESSIONS =
    BindingKey.create<AgentSessionRegistry>('agents.sessions');
}
