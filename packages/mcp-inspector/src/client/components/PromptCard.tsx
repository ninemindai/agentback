// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import {useState} from 'react';
import {type Outcome, type PromptInfo, type RecordFn} from '../api';
import {useApi} from '../ApiContext';
import {OutcomeView} from './JsonView';

export function PromptCard({
  prompt,
  record,
}: {
  prompt: PromptInfo;
  record: RecordFn;
}) {
  const api = useApi();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);

  async function get() {
    setPending(true);
    const result = await api.getPrompt(prompt.name);
    setOutcome(result);
    record('prompt', prompt.name, result);
    setPending(false);
  }

  return (
    <div className="card">
      <h3>{prompt.name}</h3>
      {prompt.description && <p className="desc">{prompt.description}</p>}
      <button className="btn" onClick={get} disabled={pending}>
        {pending ? 'Getting…' : 'Get'}
      </button>
      {outcome && <OutcomeView outcome={outcome} />}
    </div>
  );
}
