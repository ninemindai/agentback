// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import {useState} from 'react';
import {type Outcome, type RecordFn, type ResourceInfo} from '../api';
import {useApi} from '../ApiContext';
import {OutcomeView} from './JsonView';

export function ResourceCard({
  resource,
  record,
}: {
  resource: ResourceInfo;
  record: RecordFn;
}) {
  const api = useApi();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);

  async function read() {
    setPending(true);
    const result = await api.readResource(resource);
    setOutcome(result);
    record('resource', resource.name, result);
    setPending(false);
  }

  return (
    <div className="card">
      <h3>
        {resource.uri}
        {resource.mimeType && (
          <span className="badge">{resource.mimeType}</span>
        )}
      </h3>
      {resource.description && <p className="desc">{resource.description}</p>}
      <button className="btn" onClick={read} disabled={pending}>
        {pending ? 'Reading…' : 'Read'}
      </button>
      {outcome && <OutcomeView outcome={outcome} />}
    </div>
  );
}
