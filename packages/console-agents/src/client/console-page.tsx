// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/console-agents
// This file is licensed under the MIT License.

// Console page contribution. Imported at build time by @agentback/console's SPA
// bundle via this package's `./console` export, so it ships as source TSX and
// needs no bundler of its own.

import {useCallback, useEffect, useRef, useState} from 'react';

interface Step {
  text?: string;
  toolCalls?: {toolName: string; input?: unknown}[];
  toolResults?: {toolName: string; output?: unknown}[];
}

interface Props {
  apiBase: string;
  extra?: {enabled?: boolean};
}

const mono = 'var(--ab-font-mono, ui-monospace, SFMono-Regular, monospace)';

function pretty(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A disclosure row for one tool call and (when it arrives) its result. */
function ToolRow({
  name,
  input,
  output,
}: {
  name: string;
  input?: unknown;
  output?: unknown;
}) {
  return (
    <details style={{margin: '6px 0'}}>
      <summary style={{cursor: 'pointer', fontFamily: mono, fontSize: 13}}>
        <span style={{opacity: 0.6}}>tool</span> <strong>{name}</strong>
      </summary>
      <div style={{paddingLeft: 16}}>
        {input !== undefined && (
          <pre style={preStyle}>
            <span style={{opacity: 0.6}}>input </span>
            {pretty(input)}
          </pre>
        )}
        {output !== undefined && (
          <pre style={preStyle}>
            <span style={{opacity: 0.6}}>output </span>
            {pretty(output)}
          </pre>
        )}
      </div>
    </details>
  );
}

const preStyle: React.CSSProperties = {
  fontFamily: mono,
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: '4px 0',
  padding: 8,
  borderRadius: 4,
  background: 'var(--ab-surface-2, rgba(127,127,127,0.08))',
};

function Playground({apiBase, extra}: Props) {
  const [prompt, setPrompt] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    available: boolean;
    tools: string[];
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const featureOn = extra?.enabled !== false;

  useEffect(() => {
    if (!featureOn) return;
    let live = true;
    fetch(`${apiBase}/status`)
      .then(r =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then(d => live && setStatus(d))
      .catch(() => live && setStatus({available: false, tools: []}));
    return () => {
      live = false;
    };
  }, [apiBase, featureOn]);

  const run = useCallback(async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    setAnswer('');
    setSteps([]);
    try {
      const res = await fetch(`${apiBase}/turn`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({prompt: text}),
      });
      const body = await res.json();
      if (!res.ok) {
        // The framework's error envelope — surface `message`, which for an
        // AgentError is deliberately safe to show.
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      // Success is the handler's return value verbatim — no `data` wrapper.
      setAnswer(body.text ?? '');
      setSteps(body.steps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [apiBase, prompt, busy]);

  if (!featureOn) {
    return (
      <Empty title="Agent playground is off">
        Pass <code>agentsConsoleFeature(&#123;enabled: true&#125;)</code> in the
        console&apos;s <code>features</code> to turn it on. It is off by default
        because a turn spends model tokens and invokes your real tools.
      </Empty>
    );
  }

  if (status && !status.available) {
    return (
      <Empty title="No agent is bound">
        Call <code>installAgent(app, &#123;agent&#125;)</code> from{' '}
        <code>@agentback/agents</code> before installing the console. The
        playground runs <em>your</em> agent against <em>your</em> tools — it
        does not create one.
      </Empty>
    );
  }

  return (
    <div style={{padding: 20, maxWidth: 900}}>
      <h2 style={{margin: '0 0 4px'}}>Agent playground</h2>
      <p style={{margin: '0 0 16px', opacity: 0.7, fontSize: 13}}>
        One turn of this app&apos;s agent, in this process, against its own
        tools. The turn runs on the server — your model key never reaches the
        browser.
        {status?.tools.length ? (
          <>
            {' '}
            Tools:{' '}
            <code style={{fontFamily: mono}}>{status.tools.join(', ')}</code>
          </>
        ) : null}
      </p>

      <textarea
        ref={inputRef}
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        onKeyDown={e => {
          // Enter runs; Shift+Enter is a newline. Matches every chat surface a
          // developer already has muscle memory for.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void run();
          }
        }}
        placeholder="Ask the agent something that needs one of your tools…"
        rows={3}
        style={{
          width: '100%',
          fontFamily: 'inherit',
          fontSize: 14,
          padding: 10,
          borderRadius: 6,
          border: '1px solid var(--ab-border, rgba(127,127,127,0.4))',
          background: 'var(--ab-surface, transparent)',
          color: 'inherit',
          resize: 'vertical',
        }}
      />
      <div
        style={{display: 'flex', gap: 8, alignItems: 'center', marginTop: 8}}
      >
        <button
          onClick={() => void run()}
          disabled={busy || !prompt.trim()}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Running…' : 'Run turn'}
        </button>
        <span style={{opacity: 0.55, fontSize: 12}}>
          Enter to run · Shift+Enter for a newline
        </span>
      </div>

      {error && (
        <pre style={{...preStyle, color: 'var(--ab-danger, #c0392b)'}}>
          {error}
        </pre>
      )}

      {steps.length > 0 && (
        <section style={{marginTop: 20}}>
          <h3 style={{fontSize: 13, textTransform: 'uppercase', opacity: 0.6}}>
            Steps
          </h3>
          {steps.map((step, i) => (
            <div
              key={i}
              style={{
                borderLeft: '2px solid var(--ab-border, rgba(127,127,127,0.4))',
                paddingLeft: 12,
                marginBottom: 12,
              }}
            >
              {step.text && (
                <div style={{whiteSpace: 'pre-wrap', fontSize: 14}}>
                  {step.text}
                </div>
              )}
              {step.toolCalls?.map((call, k) => (
                <ToolRow
                  key={k}
                  name={call.toolName}
                  input={call.input}
                  output={
                    step.toolResults?.find(r => r.toolName === call.toolName)
                      ?.output
                  }
                />
              ))}
            </div>
          ))}
        </section>
      )}

      {answer && (
        <section style={{marginTop: 20}}>
          <h3 style={{fontSize: 13, textTransform: 'uppercase', opacity: 0.6}}>
            Answer
          </h3>
          <div style={{whiteSpace: 'pre-wrap', fontSize: 15}}>{answer}</div>
        </section>
      )}
    </div>
  );
}

function Empty({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div style={{padding: 24, maxWidth: 620}}>
      <h2 style={{margin: '0 0 8px'}}>{title}</h2>
      <p style={{opacity: 0.75, fontSize: 14, lineHeight: 1.6}}>{children}</p>
    </div>
  );
}

export const pages = [
  {
    id: 'agents',
    title: 'Agent',
    icon: '✷',
    order: 45,
    route: '/agents',
    component: Playground,
  },
];
