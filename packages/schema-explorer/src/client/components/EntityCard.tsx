// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {Fragment} from 'react';
import {
  constraints,
  isArrayRoot,
  objectShape,
  typeLabel,
  type JSchema,
} from '../lib/jsonschema';

// A few widely-supported glyphs for common string formats, shown inline next to
// the type the way an ERD tool flags a typed column. Anything unmapped falls
// back to a `format:` chip.
const FMT_GLYPH: Record<string, string> = {
  email: '✉',
  uri: '↗',
  url: '↗',
  uuid: '#',
  'date-time': '◷',
  date: '◷',
  time: '◷',
  duration: '◷',
  ipv4: '⌁',
  ipv6: '⌁',
  hostname: '⌂',
};

function Field({
  name,
  schema,
  required,
}: {
  name: string;
  schema: JSchema;
  required: boolean;
}) {
  const child = objectShape(schema);
  const fmt = schema.format;
  const fmtGlyph = fmt ? FMT_GLYPH[fmt] : undefined;
  // Drop the `format:` chip when we render it as a glyph instead.
  const cons = constraints(schema).filter(
    c => !(fmtGlyph && c.startsWith('format:')),
  );
  return (
    <Fragment>
      <div className="erow">
        <span
          className={'pip ' + (required ? 'req' : 'opt')}
          title={required ? 'required' : 'optional'}
        />
        <span className="ename">{name}</span>
        <span className="etype">
          {typeLabel(schema)}
          {child && <span className="caret">▾</span>}
        </span>
        <span className="econ">
          {fmtGlyph && (
            <span className="efmt" title={fmt}>
              {fmtGlyph}
            </span>
          )}
          {cons.map((c, i) => (
            <span className="echip" key={i}>
              {c}
            </span>
          ))}
        </span>
      </div>
      {schema.description && <div className="edesc">{schema.description}</div>}
      {child && (
        <div className="enest">
          <Card schema={child} title={null} />
        </div>
      )}
    </Fragment>
  );
}

function Card({schema, title}: {schema: JSchema; title: string | null}) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  return (
    <div className={'ecard' + (title == null ? ' nested' : '')}>
      {title != null && (
        <div className="ecard-head">
          <span className="etitle">{title}</span>
          <span className="ekind">entity</span>
        </div>
      )}
      <div className="ecard-body">
        {Object.keys(props).map(k => (
          <Field
            key={k}
            name={k}
            schema={props[k]!}
            required={required.has(k)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The schema rendered as an ERD-style entity card: a titled table-card whose
 * rows are typed columns (required pip + type + constraint chips), with nested
 * objects and array items inset as linked sub-cards. A non-object root renders
 * as a single-line typed card.
 */
export function EntityCard({schema, name}: {schema: JSchema; name: string}) {
  const root = objectShape(schema);
  if (!root) {
    return (
      <div className="ecard">
        <div className="ecard-head">
          <span className="etitle">{name}</span>
          <span className="ekind etype">{typeLabel(schema)}</span>
        </div>
      </div>
    );
  }
  return (
    <Card schema={root} title={isArrayRoot(schema) ? `${name} []` : name} />
  );
}
