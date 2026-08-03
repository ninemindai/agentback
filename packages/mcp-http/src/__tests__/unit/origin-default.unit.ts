// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {
  corsDeclaredOrigins,
  deriveOriginAllowlist,
  rejectedOriginLogger,
  setupStateless,
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
    expect(corsDeclaredOrigins({origin: 'https://app.example.com'})).toEqual([
      'https://app.example.com',
    ]);
    expect(
      corsDeclaredOrigins({origin: ['https://a.example.com', 'https://b.dev']}),
    ).toEqual(['https://a.example.com', 'https://b.dev']);
  });

  it('reports `any` when the config enumerates nothing to reuse', () => {
    // `cors: true` is `origin: '*'`; a regex or callback origin cannot be
    // listed. Guessing an allowlist here would lock out the very browser
    // client the app's own CORS config admits.
    expect(corsDeclaredOrigins(true)).toBe('any');
    expect(corsDeclaredOrigins({})).toBe('any');
    expect(corsDeclaredOrigins({origin: true})).toBe('any');
    expect(corsDeclaredOrigins({origin: '*'})).toBe('any');
    expect(corsDeclaredOrigins({origin: /example\.com$/})).toBe('any');
    expect(corsDeclaredOrigins({origin: () => true})).toBe('any');
    expect(corsDeclaredOrigins({origin: ['https://a.dev', /b\.dev/]})).toBe(
      'any',
    );
  });

  it('reports `any` for a wildcard inside an array', () => {
    // `['*']` is enumerable syntactically but means "everything" semantically,
    // so it must collapse to `any` rather than becoming a literal `*` entry
    // that could never match a real origin.
    expect(corsDeclaredOrigins({origin: ['*']})).toBe('any');
    expect(corsDeclaredOrigins({origin: ['https://a.dev', '*']})).toBe('any');
  });

  it('treats a disabled CORS config as declaring nothing', () => {
    // Not the same as `'any'`: no CORS means no cross-origin browser access at
    // all, so localhost-only is the right derived allowlist.
    expect(corsDeclaredOrigins(undefined)).toEqual([]);
    expect(corsDeclaredOrigins(false)).toEqual([]);
    expect(corsDeclaredOrigins({origin: false})).toEqual([]);
  });
});

describe('deriveOriginAllowlist', () => {
  it('falls back to localhost when protection was asked for by name', () => {
    // An explicit `true` must never become a silent no-op. With `cors: true`
    // there is nothing to enumerate, so the safe direction is localhost-only
    // plus a warning the operator can act on — not "no check at all", which
    // would leave a security flag reading enabled while enforcing nothing.
    const decision = deriveOriginAllowlist({
      corsConfig: true,
      enableDnsRebindingProtection: true,
    });
    expect(decision.origins).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect(decision.warning).toMatch(/requested explicitly/);
  });

  it('leaves validation off (with a warning) when left to the default', () => {
    const decision = deriveOriginAllowlist({corsConfig: true});
    expect(decision.origins).toBeUndefined();
    expect(decision.warning).toMatch(/NO Origin validation/);
  });

  it('warns about nothing when an allowlist is derivable', () => {
    const decision = deriveOriginAllowlist({
      corsConfig: {origin: 'https://app.example.com'},
    });
    expect(decision.origins).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'https://app.example.com',
    ]);
    expect(decision.warning).toBeUndefined();
  });

  it('passes an explicit allowlist through untouched and unwarned', () => {
    const decision = deriveOriginAllowlist({
      corsConfig: true,
      allowedOrigins: ['https://only.example.com'],
      enableDnsRebindingProtection: true,
    });
    expect(decision.origins).toEqual(['https://only.example.com']);
    expect(decision.warning).toBeUndefined();
  });
});

describe('rejectedOriginLogger', () => {
  // Asserts on the returned message rather than a log hook on purpose: the
  // framework's loggers are `debug`-namespaced and emit nothing unless `DEBUG`
  // is set, so a hook-based test would pass for the wrong reason (or fail
  // depending on the runner's environment).
  it('explains a rejection once per origin and names the fix', () => {
    const report = rejectedOriginLogger(['localhost']);
    const first = report('https://evil.test');
    expect(first).toContain('https://evil.test');
    expect(first).toContain('allowedOrigins');
    expect(first).toContain('localhost'); // the allowlist, for the operator
    expect(report('https://evil.test')).toBeUndefined(); // deduped
  });

  it('stays bounded when the caller rotates the header', () => {
    // `Origin` is caller-controlled, so an unbounded dedup set is a memory
    // amplifier and an unbounded log is a disk one.
    const report = rejectedOriginLogger(['localhost']);
    let reported = 0;
    for (let i = 0; i < 500; i++) {
      if (report(`https://evil-${i}.test`)) reported++;
    }
    expect(reported).toBeLessThanOrEqual(32);
  });

  it('reports a missing Origin distinctly from a present one', () => {
    const report = rejectedOriginLogger(['localhost']);
    expect(report(null)).toContain('(none)');
  });
});

describe('stateless Origin allowlist', () => {
  it('defaults to localhost when the app declares no CORS', async () => {
    const {allowedOriginHostnames} = setupStateless(await givenMcp(), {});
    expect(allowedOriginHostnames).toEqual(['localhost', '127.0.0.1', '[::1]']);
  });

  it('adds the origins `rest.cors` declares, as hostnames', async () => {
    const {allowedOriginHostnames} = setupStateless(await givenMcp(), {
      corsConfig: {origin: ['https://app.example.com']},
    });
    // Normalized to hostnames: the stateless check is port-agnostic, so
    // `https://app.example.com:8443` is admitted by the same entry.
    expect(allowedOriginHostnames).toEqual([
      'localhost',
      '127.0.0.1',
      '[::1]',
      'app.example.com',
    ]);
  });

  it('leaves validation off when CORS admits any origin', async () => {
    // Nothing to enumerate. Restricting to localhost would break the browser
    // app this config allows, so this warns loudly instead.
    const {allowedOriginHostnames} = setupStateless(await givenMcp(), {
      corsConfig: true,
    });
    expect(allowedOriginHostnames).toBeUndefined();
  });

  it('never overrides an explicit allowlist', async () => {
    const {allowedOriginHostnames} = setupStateless(await givenMcp(), {
      corsConfig: true,
      allowedOrigins: ['https://only.example.com'],
    });
    expect(allowedOriginHostnames).toEqual(['only.example.com']);
  });

  it('honours an explicit opt-out', async () => {
    const {allowedOriginHostnames} = setupStateless(await givenMcp(), {
      enableDnsRebindingProtection: false,
    });
    expect(allowedOriginHostnames).toBeUndefined();
  });

  it('does not derive an allowlist for the session path', async () => {
    // The session transport exact-matches the raw `Origin` header instead of
    // comparing hostnames, so a derived `localhost` would 403 a browser on
    // `http://localhost:3000`. Legacy serving keeps the old default.
    const setup = setupStateless(await givenMcp(), {protocol: 'legacy'});
    expect(setup.enabled).toBe(false);
    expect(setup.allowedOriginHostnames).toBeUndefined();
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
