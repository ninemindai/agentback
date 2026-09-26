// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Context, inject} from '@agentback/context';
import {Application, CoreBindings} from '@agentback/core';
import {AbortReasons, abortError} from '@agentback/common';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';

const In = z.object({});

@mcpServer()
class SignalTools {
  /** Reports whether it can see a signal, and whether that signal is aborted. */
  @tool('inspect', {input: In})
  inspect(
    _input: z.infer<typeof In>,
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true})
    signal?: AbortSignal,
  ) {
    return {
      present: signal !== undefined,
      aborted: signal?.aborted ?? false,
      reason: (signal?.reason as DOMException | undefined)?.message ?? null,
    };
  }
}

async function givenServer() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(SignalTools);
  return {app, server: await app.get<MCPServer>('servers.MCPServer')};
}

describe('tool abort signal', () => {
  it('is absent when the caller supplies none', async () => {
    const {server} = await givenServer();
    // A programmatic call with no ambient unit of work has nothing to cancel;
    // the tool must see `undefined`, not a signal that never fires.
    expect(await server.callTool('inspect', {})).toMatchObject({
      present: false,
    });
  });

  it('is bound from the explicit {signal} call option', async () => {
    const {server} = await givenServer();
    const controller = new AbortController();
    expect(
      await server.callTool('inspect', {}, {signal: controller.signal}),
    ).toMatchObject({present: true, aborted: false});
  });

  it('surfaces an already-aborted signal to the tool', async () => {
    const {server} = await givenServer();
    const controller = new AbortController();
    controller.abort(abortError(AbortReasons.CANCELLED));
    expect(
      await server.callTool('inspect', {}, {signal: controller.signal}),
    ).toMatchObject({
      present: true,
      aborted: true,
      reason: AbortReasons.CANCELLED,
    });
  });

  it('inherits a signal bound on the caller-supplied parent context', async () => {
    const {app, server} = await givenServer();
    // The agent-turn shape: the caller owns a context, the tool call is a
    // child of it, so the signal arrives through the chain walk with no
    // per-call plumbing.
    const turn = new Context(app, 'agent.turn');
    turn
      .bind(CoreBindings.ABORT_SIGNAL)
      .to(AbortSignal.abort(abortError(AbortReasons.DEADLINE)));
    expect(await server.callTool('inspect', {}, {ctx: turn})).toMatchObject({
      present: true,
      aborted: true,
      reason: AbortReasons.DEADLINE,
    });
  });

  it('an explicit {signal} wins over the parent context', async () => {
    const {app, server} = await givenServer();
    const turn = new Context(app, 'agent.turn');
    turn
      .bind(CoreBindings.ABORT_SIGNAL)
      .to(AbortSignal.abort(abortError(AbortReasons.DEADLINE)));
    const fresh = new AbortController();
    expect(
      await server.callTool('inspect', {}, {ctx: turn, signal: fresh.signal}),
    ).toMatchObject({present: true, aborted: false});
  });
});

describe('SDK request signal', () => {
  // The SDK aborts `extra.mcpReq.signal` with `notifications/cancelled`'s
  // `reason` — a client-supplied string, or undefined — not one of ours.
  function boundSignal(server: MCPServer, sdkSignal: AbortSignal) {
    const ctx = (
      server as unknown as {requestContextFor(extra: unknown): Context}
    ).requestContextFor({mcpReq: {signal: sdkSignal}});
    return ctx.getSync(CoreBindings.ABORT_SIGNAL);
  }

  it('is re-expressed as one of ours when the client cancels', async () => {
    const {server} = await givenServer();
    const sdk = new AbortController();
    const signal = boundSignal(server, sdk.signal);
    expect(signal.aborted).toBe(false);
    sdk.abort('user pressed stop');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason).toMatchObject({
      name: 'AbortError',
      message: AbortReasons.CANCELLED,
    });
  });

  it('is re-expressed when the SDK signal is already aborted', async () => {
    const {server} = await givenServer();
    const signal = boundSignal(server, AbortSignal.abort());
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({
      name: 'AbortError',
      message: AbortReasons.CANCELLED,
    });
  });
});
