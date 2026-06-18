// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import type {JsonSchema} from '../api';
import {constraintHint, isRequired, propType} from '../lib/schema';

interface Props {
  name: string;
  schema: JsonSchema;
  parent: JsonSchema | undefined;
  value: string | boolean;
  error?: string;
  onChange: (name: string, value: string | boolean) => void;
}

/** One tool-argument input, rendered by its JSON-Schema type. */
export function SchemaField({
  name,
  schema,
  parent,
  value,
  error,
  onChange,
}: Props) {
  const t = propType(schema);
  const id = 'f-' + name;
  const set = (v: string | boolean) => onChange(name, v);

  let control;
  if (t === 'boolean') {
    control = (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        onChange={e => set(e.target.checked)}
      />
    );
  } else if (t === 'enum') {
    control = (
      <select id={id} value={String(value)} onChange={e => set(e.target.value)}>
        <option value="" />
        {(schema.enum ?? []).map(v => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  } else if (t === 'integer' || t === 'number') {
    control = (
      <input
        id={id}
        type="number"
        value={String(value)}
        onChange={e => set(e.target.value)}
      />
    );
  } else if (t === 'object' || t === 'array') {
    control = (
      <textarea
        id={id}
        value={String(value)}
        placeholder={t === 'array' ? '[ … ]' : '{ … }'}
        onChange={e => set(e.target.value)}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type="text"
        value={String(value)}
        onChange={e => set(e.target.value)}
      />
    );
  }

  const hint = constraintHint(schema);
  return (
    <div className="field">
      <label htmlFor={id}>
        {name}
        {isRequired(parent, name) && <span className="req"> *</span>}
      </label>
      <div>
        {control}
        {hint && <div className="hint">{hint}</div>}
        {error && <div className="ferr">⚠ {error}</div>}
      </div>
    </div>
  );
}
