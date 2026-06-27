// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import type {Outcome} from '../api';

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** Renders the result (or error + Zod issues) of an invocation, plus a
 * status/elapsed line. */
export function OutcomeView({outcome}: {outcome: Outcome}) {
  const {ok, status, ms} = outcome;
  const body = ok
    ? pretty(outcome.result)
    : outcome.error +
      (outcome.issues?.length ? '\n\n' + pretty(outcome.issues) : '');
  return (
    <div>
      <pre className={'json' + (ok ? '' : ' err')}>{body}</pre>
      <div className="meta">
        <span className={ok ? 'ok' : 'bad'}>{status || '—'}</span> · {ms} ms
      </div>
    </div>
  );
}
