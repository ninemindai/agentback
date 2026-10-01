// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {
  event,
  MCPBindings,
  MCPComponent,
  mcpServer,
  type EventDelivery,
} from '@agentback/mcp';
import {InMemoryJobQueue, JOB_QUEUE} from '@agentback/messaging';
import {installMcpEvents} from '../../install.js';
import {WebhookEventDelivery} from '../../delivery.js';

// `runInstallConformance` probes served HTTP paths, and this helper mounts
// none: its whole footprint is the EVENT_DELIVERY binding, the queue worker
// and a stop hook. These tests hold it to the same contract — uninstall
// retracts the footprint, is idempotent, works after stop(), and a reinstall
// serves again — on that footprint instead of on routes.

@mcpServer()
class Events {
  @event('ping', {payload: z.object({n: z.number()})})
  any() {
    return true;
  }
}

let app: Application | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

function givenApp() {
  app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({transports: {stdio: false}});
  app.service(Events);
  return app;
}

describe('installMcpEvents (revertible install)', () => {
  it('binds the delivery port, and uninstall() retracts it', async () => {
    const a = givenApp();
    const installed = await installMcpEvents(a);
    expect(await a.get(MCPBindings.EVENT_DELIVERY)).toBe(installed.delivery);
    expect(installed.delivery).toBeInstanceOf(WebhookEventDelivery);
    await installed.uninstall();
    expect(a.isBound(MCPBindings.EVENT_DELIVERY.key)).toBe(false);
    // The app's own MCP bindings are untouched.
    expect(a.isBound(MCPBindings.SUBSCRIPTION_STORE.key)).toBe(true);
    expect(a.isBound(MCPBindings.EVENTS.key)).toBe(true);
  });

  it('is idempotent and resolves after app.stop()', async () => {
    const a = givenApp();
    const installed = await installMcpEvents(a);
    await a.start();
    await a.stop();
    await installed.uninstall();
    await installed.uninstall();
    expect(a.isBound(MCPBindings.EVENT_DELIVERY.key)).toBe(false);
  });

  it('reinstalls after uninstall', async () => {
    const a = givenApp();
    const first = await installMcpEvents(a);
    await first.uninstall();
    const second = await installMcpEvents(a);
    expect(await a.get(MCPBindings.EVENT_DELIVERY)).toBe(second.delivery);
    await second.uninstall();
    expect(a.isBound(MCPBindings.EVENT_DELIVERY.key)).toBe(false);
  });

  it('restores a delivery binding it displaced, and never removes a later shadow', async () => {
    const a = givenApp();
    const mine: EventDelivery = {
      verify: async () => {},
      deliver: async () => {},
    };
    a.bind(MCPBindings.EVENT_DELIVERY).to(mine);
    const installed = await installMcpEvents(a);
    await installed.uninstall();
    expect(await a.get(MCPBindings.EVENT_DELIVERY)).toBe(mine);

    const again = await installMcpEvents(a);
    const shadow: EventDelivery = {...mine};
    a.bind(MCPBindings.EVENT_DELIVERY).to(shadow);
    await again.uninstall();
    expect(await a.get(MCPBindings.EVENT_DELIVERY)).toBe(shadow);
  });

  it('rides the app’s JobQueue binding when there is one', async () => {
    const a = givenApp();
    const queue = new InMemoryJobQueue();
    let enqueued = 0;
    const counting = Object.create(queue) as InMemoryJobQueue;
    counting.enqueue = (async (...args: Parameters<typeof queue.enqueue>) => {
      enqueued++;
      return queue.enqueue(...args);
    }) as typeof queue.enqueue;
    a.bind(JOB_QUEUE).to(counting);
    const {delivery, uninstall} = await installMcpEvents(a);
    await delivery.deliver(
      {
        id: 'sub_1',
        principal: 'p',
        user: {} as never,
        name: 'ping',
        arguments: {},
        url: 'https://h.example.com/',
        secret: 'whsec_x',
        expiresAt: null,
        createdAt: 0,
        refreshedAt: 0,
      },
      {
        eventId: 'e1',
        name: 'ping',
        timestamp: new Date().toISOString(),
        data: {n: 1},
        cursor: null,
      },
    );
    expect(enqueued).toBe(1);
    await uninstall();
  });
});
