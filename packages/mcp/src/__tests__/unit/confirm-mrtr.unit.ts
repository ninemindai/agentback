// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {Context} from '@agentback/context';
import {isInputRequiredResult} from '@modelcontextprotocol/server';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer, type ToolBinding} from '../../mcp.server.js';
import {MCPBindings} from '../../keys.js';
import {mcpServer, tool} from '../../decorators/index.js';

// The security claim behind S6, tested where it can be attacked directly.
//
// MRTR's `requestState` is echoed back by the CLIENT, so the MCP spec requires
// treating it as attacker-controlled on re-entry — it carries no replay
// defense, no revocation and no staleness of its own. We use it only to
// TRANSPORT a token the `ConfirmationStore` already issued (single-use, TTL'd,
// fingerprinted against the exact input). These tests pin that the store, not
// the echoed state, is what authorizes.
//
// The integration tests drive real clients over a socket; this reaches
// `enforceConfirmation` directly so a forged state can actually be forged.

const DeployIn = z.object({env: z.enum(['prod', 'staging'])});

@mcpServer()
class DangerTools {
  @tool('deploy', {input: DeployIn, confirm: true})
  deploy(input: z.infer<typeof DeployIn>) {
    return {deployed: input.env};
  }
}

/** Build a server plus a request context carrying a synthetic SDK `extra`. */
async function harness() {
  const app = new Application();
  app.component(MCPComponent);
  app.service(DangerTools);
  const mcp = await app.get<MCPServer>('servers.MCPServer');
  await mcp.start();

  const server = mcp as unknown as {
    enforceConfirmation: (
      tool: ToolBinding,
      input: unknown,
      ctx?: Context,
    ) => Promise<unknown>;
  };
  const deploy = mcp.listTools().find(t => t.meta.name === 'deploy')!;

  /**
   * A request context shaped like one the SDK produces.
   * `envelope` present ⇒ modern era; `elicitation` in its capabilities ⇒ the
   * client can be prompted.
   */
  function ctxFor(opts: {
    modern?: boolean;
    canElicit?: boolean;
    requestState?: string;
    responses?: Record<string, unknown>;
  }) {
    const ctx = new Context(app, 'mcp.request');
    // Cast: only the handful of `mcpReq` fields the gate reads matter here,
    // and the SDK's full extra type is not constructible by hand.
    ctx.bind(MCPBindings.REQUEST_EXTRA).to({
      mcpReq: {
        ...(opts.modern
          ? {
              envelope: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': opts.canElicit
                  ? {elicitation: {}}
                  : {},
              },
            }
          : {}),
        requestState: <T>() => opts.requestState as T | undefined,
        ...(opts.responses ? {inputResponses: opts.responses} : {}),
      },
    } as never);
    return ctx;
  }

  return {
    app,
    ctxFor,
    gate: (input: unknown, ctx?: Context) =>
      server.enforceConfirmation(deploy, input, ctx),
  };
}

describe('confirm: — the store stays the authority under MRTR', () => {
  it('refuses a FORGED requestState', async () => {
    // The whole point. If this ever passes, `requestState` has been promoted
    // from a transport to a credential and the gate is gone.
    const h = await harness();
    try {
      await expect(
        h.gate(
          {env: 'prod'},
          h.ctxFor({
            modern: true,
            canElicit: true,
            requestState: 'not-a-real-token',
          }),
        ),
      ).rejects.toMatchObject({code: 'confirmation_invalid'});
    } finally {
      await h.app.stop();
    }
  });

  it('refuses a REAL token replayed against different arguments', async () => {
    const h = await harness();
    try {
      const issued = await h.gate(
        {env: 'prod'},
        h.ctxFor({modern: true, canElicit: true}),
      );
      expect(isInputRequiredResult(issued)).toBe(true);
      const token = (issued as {requestState: string}).requestState;

      // Same token, different payload — the fingerprint must not match.
      await expect(
        h.gate(
          {env: 'staging'},
          h.ctxFor({modern: true, canElicit: true, requestState: token}),
        ),
      ).rejects.toMatchObject({code: 'confirmation_invalid'});
    } finally {
      await h.app.stop();
    }
  });

  it('refuses a REAL token replayed a second time', async () => {
    // Single-use is a property of the store, and it must survive the change of
    // transport.
    const h = await harness();
    try {
      const issued = (await h.gate(
        {env: 'prod'},
        h.ctxFor({modern: true, canElicit: true}),
      )) as {requestState: string};
      // An affirmative answer is required alongside the token now: the token
      // proves a round trip, the accepted response proves a human said yes.
      const ctx = () =>
        h.ctxFor({
          modern: true,
          canElicit: true,
          requestState: issued.requestState,
          responses: {confirm: {action: 'accept', content: {confirm: true}}},
        });

      await expect(h.gate({env: 'prod'}, ctx())).resolves.toEqual({
        env: 'prod',
      });
      await expect(h.gate({env: 'prod'}, ctx())).rejects.toMatchObject({
        code: 'confirmation_invalid',
      });
    } finally {
      await h.app.stop();
    }
  });
});

describe('confirm: — which presentation is chosen', () => {
  it('elicits only when the client declared the capability', async () => {
    const h = await harness();
    try {
      const elicited = await h.gate(
        {env: 'prod'},
        h.ctxFor({modern: true, canElicit: true}),
      );
      expect(isInputRequiredResult(elicited)).toBe(true);

      // Modern era, but no elicitation capability: the SDK would reject an
      // elicitation outright, so this MUST be the token dance.
      await expect(
        h.gate({env: 'prod'}, h.ctxFor({modern: true, canElicit: false})),
      ).rejects.toMatchObject({code: 'confirmation_required'});

      // 2025 era: token dance, exactly as before S6.
      await expect(
        h.gate({env: 'prod'}, h.ctxFor({modern: false})),
      ).rejects.toMatchObject({code: 'confirmation_required'});

      // No request context at all (callTool, CLI, agents projection): the
      // programmatic paths cannot render a prompt either.
      await expect(h.gate({env: 'prod'})).rejects.toMatchObject({
        code: 'confirmation_required',
      });
    } finally {
      await h.app.stop();
    }
  });

  it('honours an explicit confirmationToken on every era', async () => {
    // A caller that already speaks the token dance keeps working after S6 —
    // including on a client that could have been prompted instead.
    const h = await harness();
    try {
      const err = (await h
        .gate({env: 'prod'}, h.ctxFor({modern: false}))
        .catch((e: unknown) => e)) as {confirmationToken: string};
      const confirmed = await h.gate(
        {env: 'prod', confirmationToken: err.confirmationToken},
        h.ctxFor({modern: true, canElicit: true}),
      );
      // Token stripped, ready for schema validation.
      expect(confirmed).toEqual({env: 'prod'});
    } finally {
      await h.app.stop();
    }
  });

  it('refuses to run when the human declined, even with a valid token', async () => {
    // A prompt whose answer is ignored is worse than no prompt, so the decline
    // is checked BEFORE the token.
    const h = await harness();
    try {
      const issued = (await h.gate(
        {env: 'prod'},
        h.ctxFor({modern: true, canElicit: true}),
      )) as {requestState: string};

      await expect(
        h.gate(
          {env: 'prod'},
          h.ctxFor({
            modern: true,
            canElicit: true,
            requestState: issued.requestState,
            // The BARE result, per InputResponses — the SDK explicitly does
            // not wrap these in a `{method, result}` envelope.
            responses: {confirm: {action: 'decline'}},
          }),
        ),
      ).rejects.toMatchObject({code: 'confirmation_invalid'});
    } finally {
      await h.app.stop();
    }
  });
});
