// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import {useMemo, useState} from 'react';
import {type RecordFn, type ToolInfo} from '../api';
import {useApi} from '../ApiContext';
import {coerceValue} from '../lib/coerce';
import {SchemaField} from './SchemaField';
import {OutcomeView} from './JsonView';
import type {Outcome} from '../api';

/** Initial form value for a field type: unchecked for booleans, empty otherwise. */
function initialValue(type: string | string[] | undefined): string | boolean {
  const t = Array.isArray(type) ? type[0] : type;
  return t === 'boolean' ? false : '';
}

export function ToolCard({
  tool,
  record,
  open,
  onToggleOpen,
}: {
  tool: ToolInfo;
  record: RecordFn;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const api = useApi();
  const props = tool.inputSchema?.properties ?? {};
  const names = useMemo(() => Object.keys(props), [props]);

  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(names.map(n => [n, initialValue(props[n]?.type)])),
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState(false);

  // Map Zod issues from the last failed call onto their originating field.
  const fieldErrors: Record<string, string> = {};
  const generalErrors: string[] = [];
  if (outcome && !outcome.ok && outcome.issues) {
    for (const iss of outcome.issues) {
      const key = iss.path?.[0];
      if (typeof key === 'string' && key in props) {
        fieldErrors[key] = iss.message ?? 'invalid';
      } else if (iss.message) {
        generalErrors.push(iss.message);
      }
    }
  }

  async function run() {
    const args: Record<string, unknown> = {};
    for (const n of names) {
      const v = coerceValue(values[n]!, props[n]!);
      if (v !== undefined) args[n] = v;
    }
    setPending(true);
    const result = await api.callTool(tool.name, args);
    setOutcome(result);
    record('tool', tool.name, result);
    setPending(false);
  }

  return (
    <div className="card">
      <h3 className="card-head" onClick={onToggleOpen}>
        <span className="fold">{open ? '▾' : '▸'}</span>
        {tool.name}
        {tool.title && <span className="badge">{tool.title}</span>}
        {!open && tool.description && (
          <span className="head-desc">{tool.description}</span>
        )}
      </h3>
      {open && (
        <>
          {tool.description && <p className="desc">{tool.description}</p>}
          {names.map(n => (
            <SchemaField
              key={n}
              name={n}
              schema={props[n]!}
              parent={tool.inputSchema}
              value={values[n] ?? ''}
              error={fieldErrors[n]}
              onChange={(name, v) => setValues(s => ({...s, [name]: v}))}
            />
          ))}
          {generalErrors.length > 0 && (
            <div className="banner">{generalErrors.join('; ')}</div>
          )}
          <button className="btn" onClick={run} disabled={pending}>
            {pending ? 'Running…' : 'Run'}
          </button>
          {outcome && <OutcomeView outcome={outcome} />}
          {tool.outputSchema && (
            <details className="collapse">
              <summary>output schema</summary>
              <pre className="json">
                {JSON.stringify(tool.outputSchema, null, 2)}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
