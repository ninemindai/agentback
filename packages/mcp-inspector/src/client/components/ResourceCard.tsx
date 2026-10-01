// Copyright NineMind, Inc. 2026. All Rights Reserved.
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
        {resource.title && <span className="badge">{resource.title}</span>}
        {resource.mimeType && (
          <span className="badge">{resource.mimeType}</span>
        )}
      </h3>
      {resource.description && <p className="desc">{resource.description}</p>}
      {(resource.icons || resource.contentMeta) && (
        <details className="collapse">
          <summary>host metadata</summary>
          <pre className="json">
            {JSON.stringify(
              {icons: resource.icons, contentMeta: resource.contentMeta},
              null,
              2,
            )}
          </pre>
        </details>
      )}
      <button className="btn" onClick={read} disabled={pending}>
        {pending ? 'Reading…' : 'Read'}
      </button>
      {outcome && <OutcomeView outcome={outcome} />}
    </div>
  );
}
