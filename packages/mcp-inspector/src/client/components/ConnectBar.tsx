// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import {useEffect, useRef, useState} from 'react';
import {
  addTarget,
  removeTarget,
  type AuthInput,
  type RemoteTarget,
} from '../api';

type AuthType = 'none' | 'bearer' | 'oauth';

/**
 * Target switcher + "add remote server" panel. Lets the inspector point at the
 * local in-process server (`local`) or any remote MCP server connected through
 * mcp-connect. For OAuth servers it opens the authorization URL in a popup and
 * waits for the callback page's `postMessage` before refreshing.
 */
export function ConnectBar({
  connectBase,
  active,
  targets,
  onSelect,
  onTargetsChanged,
}: {
  connectBase: string; // mcp-connect API base, e.g. /mcp-connect/api
  active: string; // 'local' | target id
  targets: RemoteTarget[];
  onSelect: (target: string) => void;
  onTargetsChanged: () => void | Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<AuthType>('none');
  const [token, setToken] = useState('');
  const [scope, setScope] = useState('');
  const [skipResource, setSkipResource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  function reset() {
    setUrl('');
    setAuthType('none');
    setToken('');
    setScope('');
    setSkipResource(false);
    setErr(null);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const auth: AuthInput =
        authType === 'bearer'
          ? {type: 'bearer', token}
          : authType === 'oauth'
            ? {
                type: 'oauth',
                ...(scope.trim() ? {scope: scope.trim()} : {}),
                ...(skipResource ? {resource: false as const} : {}),
              }
            : {type: 'none'};
      const res = await addTarget(connectBase, url.trim(), auth);
      if (res.status === 'authorize' && res.authorizationUrl) {
        // Open the AS in a popup; the callback page postMessages us back.
        popupRef.current = window.open(
          res.authorizationUrl,
          'mcp-oauth',
          'width=520,height=720',
        );
        await waitForOAuth();
      }
      await onTargetsChanged();
      onSelect(res.id);
      setAdding(false);
      reset();
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  function waitForOAuth(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMsg = (ev: MessageEvent) => {
        // Only trust the callback page we served (same origin as this UI).
        if (ev.origin !== window.location.origin) return;
        const d = ev.data as
          | {source?: string; type?: string; ok?: boolean}
          | undefined;
        if (d?.source !== 'mcp-connect' || d.type !== 'oauth-complete') return;
        cleanup();
        if (d.ok) resolve();
        else reject(new Error('Authorization was denied or failed'));
      };
      const timer = window.setInterval(() => {
        if (popupRef.current?.closed) {
          cleanup();
          reject(new Error('Authorization window was closed'));
        }
      }, 600);
      function cleanup() {
        window.removeEventListener('message', onMsg);
        window.clearInterval(timer);
      }
      window.addEventListener('message', onMsg);
    });
  }

  async function disconnect(id: string) {
    await removeTarget(connectBase, id);
    if (active === id) onSelect('local');
    await onTargetsChanged();
  }

  const activeRemote = targets.find(t => t.id === active);

  return (
    <div className="connectbar">
      <label className="connect-target">
        <span className="ct-label">Server</span>
        <select
          value={active}
          onChange={e => onSelect(e.target.value)}
          aria-label="Active MCP server"
        >
          <option value="local">Local (in-process)</option>
          {targets.length > 0 && (
            <optgroup label="Remote">
              {targets.map(t => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.status === 'authorizing' ? ' (authorizing…)' : ''}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {activeRemote && (
        <button
          className="ghost"
          title={'Disconnect ' + activeRemote.url}
          onClick={() => disconnect(activeRemote.id)}
        >
          Disconnect
        </button>
      )}
      <button className="ghost" onClick={() => setAdding(a => !a)}>
        {adding ? 'Cancel' : '＋ Add server'}
      </button>

      {adding && (
        <div className="add-panel">
          <div className="field">
            <label>URL</label>
            <input
              type="text"
              placeholder="https://mcp.notion.com/mcp"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Auth</label>
            <select
              value={authType}
              onChange={e => setAuthType(e.target.value as AuthType)}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="oauth">OAuth 2.1 (interactive)</option>
            </select>
          </div>
          {authType === 'bearer' && (
            <div className="field">
              <label>Token</label>
              <input
                type="text"
                placeholder="access token"
                value={token}
                onChange={e => setToken(e.target.value)}
              />
            </div>
          )}
          {authType === 'oauth' && (
            <>
              <div className="field">
                <label>Scope</label>
                <input
                  type="text"
                  placeholder="(optional) space-delimited scopes"
                  value={scope}
                  onChange={e => setScope(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Resource</label>
                <label className="ct-check">
                  <input
                    type="checkbox"
                    checked={skipResource}
                    onChange={e => setSkipResource(e.target.checked)}
                  />
                  skip RFC 8707 resource check
                </label>
              </div>
            </>
          )}
          {err && <p className="banner">{err}</p>}
          <button
            className="btn"
            onClick={submit}
            disabled={busy || !url.trim() || (authType === 'bearer' && !token)}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      )}
    </div>
  );
}
