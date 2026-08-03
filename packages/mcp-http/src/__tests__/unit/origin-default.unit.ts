// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {
  corsDeclaredOrigins,
  deriveOriginAllowlist,
  originAllowed,
  rejectedOriginLogger,
  setupStateless,
  type OriginRule,
} from '../../session.js';
import {rejectedBeforeDispatch} from '../../tool-rate-limit.js';

// Every Streamable HTTP revision since 2025-03-26 says "Servers MUST validate
// the `Origin` header on all incoming connections to prevent DNS rebinding
// attacks". The allowlist therefore defaults ON rather than only when
// configured — and is derived from `rest.cors`, which is the same statement of
// which browsers may call the app, so it is not configured twice.

@mcpServer()
class Tools {
  @tool('ping')
  ping() {
    return {ok: true};
  }
}

async function givenMcp(): Promise<MCPServer> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'origin',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(Tools);
  return app.get<MCPServer>('servers.MCPServer');
}

describe('corsDeclaredOrigins', () => {
  it('enumerates the origins a CORS config names', () => {
    expect(corsDeclaredOrigins({origin: 'https://app.example.com'})).toEqual({
      exact: ['https://app.example.com'],
      patterns: [],
    });
    expect(
      corsDeclaredOrigins({origin: ['https://a.example.com', 'https://b.dev']}),
    ).toEqual({
      exact: ['https://a.example.com', 'https://b.dev'],
      patterns: [],
    });
  });

  it('keeps a RegExp origin instead of discarding it', () => {
    // This used to collapse to `'any'`, which gave a *restrictive* config the
    // least protection of the three cases — worse than a wildcard, which at
    // least is honest about admitting everything. Regexes are pure, so they
    // can be evaluated per request.
    const re = /\.example\.com$/;
    expect(corsDeclaredOrigins({origin: re})).toEqual({
      exact: [],
      patterns: [re],
    });
    expect(corsDeclaredOrigins({origin: ['https://a.dev', re]})).toEqual({
      exact: ['https://a.dev'],
      patterns: [re],
    });
  });

  it('reports `any` only when the config truly admits everything', () => {
    // A callback origin is `(origin, callback) => void`: asynchronous and free
    // to have side effects, so a transport guard cannot invoke it per request.
    expect(corsDeclaredOrigins(true)).toBe('any');
    expect(corsDeclaredOrigins({})).toBe('any');
    expect(corsDeclaredOrigins({origin: true})).toBe('any');
    expect(corsDeclaredOrigins({origin: '*'})).toBe('any');
    expect(corsDeclaredOrigins({origin: () => true})).toBe('any');
  });

  it('reports `any` for a wildcard inside an array', () => {
    expect(corsDeclaredOrigins({origin: ['*']})).toBe('any');
    expect(corsDeclaredOrigins({origin: ['https://a.dev', '*']})).toBe('any');
  });

  it('treats a disabled CORS config as declaring nothing', () => {
    // Not the same as `'any'`: no CORS means no cross-origin browser access at
    // all, so localhost-only is the right derived allowlist.
    const none = {exact: [], patterns: []};
    expect(corsDeclaredOrigins(undefined)).toEqual(none);
    expect(corsDeclaredOrigins(false)).toEqual(none);
    expect(corsDeclaredOrigins({origin: false})).toEqual(none);
  });
});

describe('originAllowed', () => {
  const localhost: OriginRule = {
    kind: 'hostname',
    values: ['localhost', '127.0.0.1'],
  };

  it('passes a request that sends no Origin at all', () => {
    // Only browsers send `Origin`; an absent one is a non-browser client and
    // is not what rebinding defense is aimed at.
    expect(originAllowed(undefined, [localhost])).toBe(true);
    expect(originAllowed(null, [localhost])).toBe(true);
    expect(originAllowed('', [localhost])).toBe(true);
  });

  it('rejects the opaque `null` Origin', () => {
    expect(originAllowed('null', [localhost])).toBe(false);
  });

  it('matches an exact rule on scheme AND port', () => {
    // The whole point of the exact rule: a precise CORS grant stays precise.
    const rules: OriginRule[] = [
      {kind: 'exact', values: ['https://app.example.com']},
    ];
    expect(originAllowed('https://app.example.com', rules)).toBe(true);
    expect(originAllowed('http://app.example.com', rules)).toBe(false);
    expect(originAllowed('https://app.example.com:8443', rules)).toBe(false);
    expect(originAllowed('https://evil.test', rules)).toBe(false);
  });

  it('canonicalizes both sides before comparing', () => {
    // `https://x/` and `https://x:443` are the same origin; a trailing slash
    // or an explicit default port must not cause a spurious 403.
    const rules: OriginRule[] = [
      {kind: 'exact', values: ['https://app.example.com/']},
    ];
    expect(originAllowed('https://app.example.com', rules)).toBe(true);
    expect(originAllowed('https://app.example.com:443', rules)).toBe(true);
  });

  it('tests a pattern rule against the canonical origin', () => {
    const rules: OriginRule[] = [
      {kind: 'pattern', values: [/\.example\.com$/]},
    ];
    expect(originAllowed('https://app.example.com', rules)).toBe(true);
    // Anchored `$` must not be dodged by a trailing slash or default port.
    expect(originAllowed('https://app.example.com:443', rules)).toBe(true);
    expect(originAllowed('https://evil.test', rules)).toBe(false);
    expect(originAllowed('https://example.com.evil.test', rules)).toBe(false);
  });

  it('keeps hostname semantics for the hostname rule', () => {
    // Explicit `allowedOrigins` and the localhost defaults stay port- and
    // scheme-agnostic: dev servers move ports, and narrowing a shipped option
    // would 403 callers who already set it.
    expect(originAllowed('http://localhost:3000', [localhost])).toBe(true);
    expect(originAllowed('https://localhost', [localhost])).toBe(true);
    expect(originAllowed('http://evil.test', [localhost])).toBe(false);
  });

  it('admits when ANY rule matches', () => {
    const rules: OriginRule[] = [
      localhost,
      {kind: 'exact', values: ['https://app.example.com']},
    ];
    expect(originAllowed('http://localhost:5173', rules)).toBe(true);
    expect(originAllowed('https://app.example.com', rules)).toBe(true);
    expect(originAllowed('https://evil.test', rules)).toBe(false);
  });

  it('never matches on an unparseable configured entry', () => {
    // A bare hostname in `cors.origin` is already a broken CORS config (browsers
    // send full origins). It must fail closed, not widen to everything.
    const rules: OriginRule[] = [{kind: 'exact', values: ['app.example.com']}];
    expect(originAllowed('https://app.example.com', rules)).toBe(false);
  });
});

describe('deriveOriginAllowlist', () => {
  it('falls back to localhost when protection was asked for by name', () => {
    const decision = deriveOriginAllowlist({
      corsConfig: true,
      enableDnsRebindingProtection: true,
    });
    expect(decision.rules).toEqual([
      {kind: 'hostname', values: ['localhost', '127.0.0.1', '[::1]']},
    ]);
    expect(decision.warning).toMatch(/requested explicitly/);
  });

  it('leaves validation off (with a warning) when left to the default', () => {
    const decision = deriveOriginAllowlist({corsConfig: true});
    expect(decision.rules).toBeUndefined();
    expect(decision.warning).toMatch(/NO Origin validation/);
  });

  it('derives an EXACT rule from a CORS origin, plus localhost', () => {
    const decision = deriveOriginAllowlist({
      corsConfig: {origin: 'https://app.example.com'},
    });
    expect(decision.rules).toEqual([
      {kind: 'hostname', values: ['localhost', '127.0.0.1', '[::1]']},
      {kind: 'exact', values: ['https://app.example.com']},
    ]);
    expect(decision.warning).toBeUndefined();
  });

  it('derives a PATTERN rule from a CORS regex', () => {
    // The case that previously got no validation at all.
    const re = /\.example\.com$/;
    const decision = deriveOriginAllowlist({corsConfig: {origin: re}});
    expect(decision.rules).toContainEqual({kind: 'pattern', values: [re]});
    expect(decision.warning).toBeUndefined();
  });

  it('keeps hostname semantics for an explicit allowlist', () => {
    const decision = deriveOriginAllowlist({
      corsConfig: true,
      allowedOrigins: ['https://only.example.com'],
      enableDnsRebindingProtection: true,
    });
    expect(decision.rules).toEqual([
      {kind: 'hostname', values: ['only.example.com']},
    ]);
    expect(decision.warning).toBeUndefined();
  });
});

describe('rejectedOriginLogger', () => {
  // Asserts on the returned message rather than a log hook on purpose: the
  // framework's loggers are `debug`-namespaced and emit nothing unless `DEBUG`
  // is set, so a hook-based test would pass for the wrong reason (or fail
  // depending on the runner's environment).
  it('explains a rejection once per origin and names the fix', () => {
    const report = rejectedOriginLogger('hostname localhost');
    const first = report('https://evil.test');
    expect(first).toContain('https://evil.test');
    expect(first).toContain('allowedOrigins');
    expect(first).toContain('localhost'); // the allowlist, for the operator
    expect(report('https://evil.test')).toBeUndefined(); // deduped
  });

  it('never goes permanently blind after a flood of junk origins', () => {
    // A hard cap would let an attacker send 32 junk `Origin` values right after
    // a deploy and silence every later rejection — including the real customer
    // origin an operator needs during an incident. Eviction keeps the tracker
    // bounded without handing observability to the caller.
    const report = rejectedOriginLogger('hostname localhost');
    for (let i = 0; i < 500; i++) report(`https://evil-${i}.test`);

    const legit = report('https://app.example.com');
    expect(legit).toContain('app.example.com');
  });

  it('still suppresses an immediate repeat', () => {
    const report = rejectedOriginLogger('hostname localhost');
    expect(report('https://evil.test')).toBeTruthy();
    expect(report('https://evil.test')).toBeUndefined();
  });

  it('reports a missing Origin distinctly from a present one', () => {
    const report = rejectedOriginLogger('hostname localhost');
    expect(report(null)).toContain('(none)');
  });
});

describe('stateless Origin allowlist', () => {
  it('defaults to localhost when the app declares no CORS', async () => {
    const {originRules} = setupStateless(await givenMcp(), {});
    expect(originRules).toEqual([
      {kind: 'hostname', values: ['localhost', '127.0.0.1', '[::1]']},
    ]);
  });

  it('adds the origins `rest.cors` declares, at exact precision', async () => {
    const {originRules} = setupStateless(await givenMcp(), {
      corsConfig: {origin: ['https://app.example.com']},
    });
    // The CORS origin becomes an EXACT rule — scheme and port included — so a
    // precise grant is not widened to the whole hostname. Localhost stays
    // hostname-matched so dev servers can move ports.
    expect(originRules).toEqual([
      {kind: 'hostname', values: ['localhost', '127.0.0.1', '[::1]']},
      {kind: 'exact', values: ['https://app.example.com']},
    ]);
  });

  it('leaves validation off when CORS admits any origin', async () => {
    // Nothing to enumerate. Restricting to localhost would break the browser
    // app this config allows, so this warns loudly instead.
    const {originRules} = setupStateless(await givenMcp(), {
      corsConfig: true,
    });
    expect(originRules).toBeUndefined();
  });

  it('never overrides an explicit allowlist', async () => {
    const {originRules} = setupStateless(await givenMcp(), {
      corsConfig: true,
      allowedOrigins: ['https://only.example.com'],
    });
    expect(originRules).toEqual([
      {kind: 'hostname', values: ['only.example.com']},
    ]);
  });

  it('honours an explicit opt-out', async () => {
    const {originRules} = setupStateless(await givenMcp(), {
      enableDnsRebindingProtection: false,
    });
    expect(originRules).toBeUndefined();
  });

  it('does not derive an allowlist for the session path', async () => {
    // The session transport exact-matches the raw `Origin` header instead of
    // comparing hostnames, so a derived `localhost` would 403 a browser on
    // `http://localhost:3000`. Legacy serving keeps the old default.
    const setup = setupStateless(await givenMcp(), {protocol: 'legacy'});
    expect(setup.enabled).toBe(false);
    expect(setup.originRules).toBeUndefined();
  });
});

describe('rejectedBeforeDispatch', () => {
  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': {name: 'c', version: '0'},
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const modernCall = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {name: 'echo', arguments: {}, _meta: envelope},
  };
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  it('passes a well-formed modern request', () => {
    expect(
      rejectedBeforeDispatch({
        httpMethod: 'POST',
        header: headers({
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'echo',
        }),
        body: modernCall,
      }),
    ).toBe(false);
  });

  it('passes legacy traffic, which has no ladder', () => {
    expect(
      rejectedBeforeDispatch({
        httpMethod: 'POST',
        header: headers({}),
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {name: 'e'},
        },
      }),
    ).toBe(false);
  });

  it('catches a header that disagrees with the body', () => {
    // `-32020` HeaderMismatch: the 2026-07-28 binding requires `Mcp-Method`
    // and `MCP-Protocol-Version` to mirror the body.
    expect(
      rejectedBeforeDispatch({
        httpMethod: 'POST',
        header: headers({
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
          'mcp-name': 'echo',
        }),
        body: modernCall,
      }),
    ).toBe(true);
    expect(
      rejectedBeforeDispatch({
        httpMethod: 'POST',
        header: headers({
          'mcp-protocol-version': '2025-06-18',
          'mcp-method': 'tools/call',
          'mcp-name': 'echo',
        }),
        body: modernCall,
      }),
    ).toBe(true);
  });

  it('catches a batch carrying modern elements', () => {
    // The amplifying case: `tallyToolCalls` counts every entry, so this would
    // otherwise debit one point per element for zero executed tools.
    expect(
      rejectedBeforeDispatch({
        httpMethod: 'POST',
        header: headers({
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'echo',
        }),
        body: [modernCall, modernCall, modernCall],
      }),
    ).toBe(true);
  });

  it('handles a body that could not be parsed at all', () => {
    // The fetch host sets `parsedBody = undefined` when `req.json()` throws,
    // so unparseable JSON — a cheap thing for a hostile client to send — must
    // not blow up the pre-check. Whatever it decides, it must decide it
    // without throwing, since this runs before the SDK sees the request.
    expect(() =>
      rejectedBeforeDispatch({
        httpMethod: 'POST',
        header: headers({'mcp-protocol-version': '2026-07-28'}),
        body: undefined,
      }),
    ).not.toThrow();
  });

  it('does not claim to catch an absent standard header', () => {
    // Pins the documented gap: the missing-header cell is validated a rung
    // later by an un-exported SDK function, so the classifier still routes
    // this as modern. If a future SDK moves the check earlier, this test
    // fails and the comment in `rejectedBeforeDispatch` needs updating.
    expect(
      rejectedBeforeDispatch({
        httpMethod: 'POST',
        header: headers({'mcp-protocol-version': '2026-07-28'}),
        body: modernCall,
      }),
    ).toBe(false);
  });
});
