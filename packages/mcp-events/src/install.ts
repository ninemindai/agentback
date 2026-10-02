// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {installSteps, loggers} from '@agentback/common';
import type {Binding} from '@agentback/context';
import {
  revertOwned,
  unbindOwned,
  type Application,
  type Installed,
} from '@agentback/core';
import {MCPBindings} from '@agentback/mcp';
import {InMemoryJobQueue, JOB_QUEUE, type JobQueue} from '@agentback/messaging';
import {WebhookEventDelivery, type WebhookDeliveryOptions} from './delivery.js';
import {createPinnedTransport} from './pinned-transport.js';
import type {WebhookTransport} from './transport.js';

const log = loggers('agentback:mcp-events');

/** Options for {@link installMcpEvents}. */
export interface McpEventsOptions extends WebhookDeliveryOptions {
  /**
   * How webhook POSTs leave the process. Defaults to
   * {@link createPinnedTransport} — the IP-pinned Node transport. On a host
   * without `node:https`, pass `fetchTransport(fetch)` and read its caveat.
   */
  transport?: WebhookTransport;
  /**
   * The job queue deliveries and their retries ride on. Defaults to the
   * app's `messaging.JobQueue` binding when there is one (bind the BullMQ
   * adapter for retries that survive a restart), else a private in-memory
   * queue.
   */
  queue?: JobQueue;
}

/**
 * Turn on MCP Events webhook delivery: binds a {@link WebhookEventDelivery}
 * at `MCPBindings.EVENT_DELIVERY` (until then `events/subscribe` answers
 * `-32014 Unsupported`) and starts its queue worker, which stops on
 * `app.stop()`.
 *
 * Returns `Installed`: `uninstall()` stops the worker, removes the stop hook,
 * and unbinds the delivery port — restoring a binding it displaced, and only
 * if the port is still the one this call bound. Idempotent. Subscriptions are
 * not touched: they live in `MCPBindings.SUBSCRIPTION_STORE`, and with no
 * delivery bound an emit simply has nowhere to send them.
 *
 * @example
 *   app.component(MCPComponent);
 *   app.service(DocEvents); // @mcpServer class with @event methods
 *   await installMcpEvents(app);
 *   await installMcpHttp(app, {auth}); // webhook mode needs a principal
 */
export async function installMcpEvents(
  app: Application,
  options: McpEventsOptions = {},
): Promise<{delivery: WebhookEventDelivery} & Installed> {
  const {value, teardown} = await installSteps(async function* () {
    const queue =
      options.queue ??
      (await app.get(JOB_QUEUE, {optional: true})) ??
      new InMemoryJobQueue();
    const delivery = new WebhookEventDelivery(
      options.transport ?? createPinnedTransport(),
      queue,
      () => app.get(MCPBindings.SUBSCRIPTION_STORE),
      options,
    );

    const displaced = app.isBound(MCPBindings.EVENT_DELIVERY.key)
      ? app.getBinding(MCPBindings.EVENT_DELIVERY.key)
      : undefined;
    if (displaced) {
      log.warn('installMcpEvents replaces an existing EVENT_DELIVERY binding');
    }
    const bound = app.bind(MCPBindings.EVENT_DELIVERY).to(delivery);
    yield () => {
      revertOwned(app, bound, displaced as Binding | undefined);
    };

    const worker = delivery.start();
    // Close once, whichever comes first: app.stop() or uninstall().
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= worker.close());
    yield close;
    const stopHook = app.onStop(close);
    yield () => unbindOwned(app, stopHook);

    return {delivery};
  });
  return {...value, uninstall: () => teardown.run()};
}
