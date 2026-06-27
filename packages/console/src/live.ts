// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import type {Request, Response} from 'express';

/**
 * One id per process. A *changed* BOOT_ID seen by the client after an SSE
 * reconnect means the app restarted — the trigger for live reflection.
 */
export const BOOT_ID = randomUUID();

/** Heartbeat cadence; matches the console-chat SSE keepalive. */
export const LIVE_HEARTBEAT_MS = 15000;

/**
 * Express handler for `GET {basePath}/live`. Sends a single `hello` frame with
 * BOOT_ID, then SSE comment heartbeats to keep the connection open. Cleans up
 * on client disconnect. Mounted directly on `server.expressApp` (Task 2) so
 * RestServer.sendResult never ends the stream.
 */
export function liveHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({type: 'hello', bootId: BOOT_ID})}\n\n`);
  const hb = setInterval(() => res.write(':hb\n\n'), LIVE_HEARTBEAT_MS);
  req.on('close', () => clearInterval(hb));
}
