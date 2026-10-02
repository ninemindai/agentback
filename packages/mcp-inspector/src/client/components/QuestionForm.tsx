// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import {useState} from 'react';
import type {JsonSchema} from '../api';
import {coerceValue} from '../lib/coerce';
import {SchemaField} from './SchemaField';

/** One question a tool asked (`elicit.ask`, a `confirm:` prompt). */
export interface Question {
  message?: string;
  requestedSchema?: JsonSchema;
}

export type QuestionAnswer =
  | {action: 'accept'; content: Record<string, unknown>}
  | {action: 'decline'};

/**
 * The form for every question a tool asked in one round. Answer submits all
 * of them; Decline declines all of them (the tool decides what that means).
 */
export function QuestionForm({
  questions,
  pending,
  onSubmit,
}: {
  questions: Record<string, Question>;
  pending: boolean;
  onSubmit: (answers: Record<string, QuestionAnswer>) => void;
}) {
  const keys = Object.keys(questions);
  const [values, setValues] = useState<
    Record<string, Record<string, string | boolean>>
  >(() =>
    Object.fromEntries(
      keys.map(k => [
        k,
        Object.fromEntries(
          Object.entries(questions[k].requestedSchema?.properties ?? {}).map(
            ([n, s]) => [n, s.type === 'boolean' ? false : ''],
          ),
        ),
      ]),
    ),
  );

  function answer() {
    const out: Record<string, QuestionAnswer> = {};
    for (const k of keys) {
      const props = questions[k].requestedSchema?.properties ?? {};
      const content: Record<string, unknown> = {};
      for (const [n, s] of Object.entries(props)) {
        const v = coerceValue(values[k]?.[n] ?? '', s);
        if (v !== undefined) content[n] = v;
      }
      out[k] = {action: 'accept', content};
    }
    onSubmit(out);
  }

  function decline() {
    onSubmit(
      Object.fromEntries(keys.map(k => [k, {action: 'decline'} as const])),
    );
  }

  return (
    <div className="question">
      <strong>The tool is asking:</strong>
      {keys.map(k => {
        const q = questions[k];
        const props = q.requestedSchema?.properties ?? {};
        return (
          <fieldset key={k} className="question-set">
            <legend>{q.message ?? k}</legend>
            {Object.entries(props).map(([n, s]) => (
              <SchemaField
                key={n}
                name={`${k}.${n}`}
                schema={s}
                parent={q.requestedSchema}
                value={values[k]?.[n] ?? ''}
                onChange={(_name, v) =>
                  setValues(all => ({...all, [k]: {...all[k], [n]: v}}))
                }
              />
            ))}
          </fieldset>
        );
      })}
      <button className="btn" onClick={answer} disabled={pending}>
        {pending ? 'Sending…' : 'Answer'}
      </button>{' '}
      <button className="ghost" onClick={decline} disabled={pending}>
        Decline
      </button>
    </div>
  );
}
