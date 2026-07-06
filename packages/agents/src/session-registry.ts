// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {AgentSessionLike} from './port.js';

const log = loggers('agentback:agents:sessions');

/**
 * Tracks live agent sessions so `app.stop()` can destroy every one — a
 * leaked harness session is a *billing* cloud sandbox, not just a dangling
 * handle. Sessions created through the wrapped agent register here
 * automatically; `destroyAll` is wired into `app.onStop` by `installAgent`.
 */
export class AgentSessionRegistry {
  private readonly sessions = new Set<AgentSessionLike>();

  register<S extends AgentSessionLike>(session: S): S {
    this.sessions.add(session);
    return session;
  }

  unregister(session: AgentSessionLike): void {
    this.sessions.delete(session);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Destroy every live session; failures are logged, never rethrown. */
  async destroyAll(): Promise<void> {
    const all = [...this.sessions];
    this.sessions.clear();
    const results = await Promise.allSettled(all.map(s => s.destroy()));
    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn('Failed to destroy agent session: %s', r.reason);
      }
    }
  }
}
