// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  Express,
  Request as ExRequest,
  Response as ExResponse,
} from 'express';
import {loggers} from '@agentback/common';
import type {RestApplication} from '@agentback/rest';
import {
  ChatBindings,
  type ChatDispatch,
  type ChatPrincipalResolver,
} from './keys.js';
import type {ChatLike} from './port.js';

const log = loggers('agentback:chat');
const DEFAULT_BASE_PATH = '/api/chat';

/**
 * `express.json({verify})` hook that stashes the **exact request bytes** on
 * `req.rawBody`. Required so signature-verifying adapters (Slack/Teams HMAC the
 * raw body) work behind AgentBack's JSON parser — re-serializing the parsed
 * body changes whitespace/key order and breaks verification.
 *
 * @example
 *   new RestApplication({rest: {bodyParser: {json: {verify: chatJsonVerify}}}})
 */
export function chatJsonVerify(
  req: {rawBody?: Buffer},
  _res: unknown,
  buf: Buffer,
): void {
  req.rawBody = buf;
}

/** Handle returned by {@link installChat}/{@link mountChatWebhooks}. */
export interface ChatHttpHandle {
  /** Adapter name → mounted webhook path. */
  readonly paths: Record<string, string>;
}

export interface InstallChatOptions {
  /** The chat runtime (e.g. `new Chat({adapters})`). */
  chat: ChatLike;
  /** Path prefix for webhooks. Default `/api/chat` → `/api/chat/<adapter>`. */
  basePath?: string;
  /** Per-adapter absolute path overrides, keyed by adapter name. */
  paths?: Record<string, string>;
  /**
   * Defer background turn processing the chat runtime hands back (Chat SDK's
   * `waitUntil`). On Vercel pass `after`. Defaults to fire-and-forget, with
   * rejections logged.
   */
  waitUntil?: (p: Promise<unknown>) => void;
  /**
   * How multiple handlers for one event run — `sequential` (default) or
   * `parallel`. Errors are isolated either way. See {@link ChatDispatch}.
   */
  dispatch?: ChatDispatch;
  /**
   * Establish the authenticated principal per event. Runs at dispatch with the
   * sender the runtime parsed; its result is bound as `SecurityBindings.USER`
   * in the per-call context. See {@link ChatPrincipalResolver}.
   */
  principal?: ChatPrincipalResolver;
}

/**
 * Mount a chat runtime as a third inbound surface on the RestApplication's
 * Express, discover `@chatBot` handlers, and wire graceful shutdown.
 *
 * Call BEFORE `app.start()`. Requires {@link ChatComponent} (for
 * `ChatBindings.SERVER`). For signature-verifying adapters, also construct the
 * app with {@link chatJsonVerify} (see its docs).
 *
 * @example
 *   const app = new RestApplication({
 *     rest: {bodyParser: {json: {verify: chatJsonVerify}}},
 *   });
 *   app.component(ChatComponent);
 *   app.service(SupportBot);
 *   const chat = new Chat({adapters: {slack, telegram}, state});
 *   await installChat(app, {chat});
 *   await app.start();
 */
export async function installChat(
  app: RestApplication,
  options: InstallChatOptions,
): Promise<ChatHttpHandle> {
  if (!app.isBound(ChatBindings.SERVER)) {
    throw new Error(
      '@agentback/chat: no ChatServer bound at ' +
        `'${ChatBindings.SERVER.key}'. Add ChatComponent before installChat.`,
    );
  }
  // Merge optional bound config (e.g. from @agentback/config) — explicit
  // installChat options win. Secrets are never read here; adapters take them
  // from env.
  const bound = app.isBound(ChatBindings.CONFIG)
    ? await app.get(ChatBindings.CONFIG)
    : undefined;
  const merged: Omit<InstallChatOptions, 'chat'> = {
    basePath: options.basePath ?? bound?.basePath,
    paths: {...bound?.paths, ...options.paths},
    waitUntil: options.waitUntil,
    dispatch: options.dispatch ?? bound?.dispatch,
    principal: options.principal,
  };

  const server = await app.get(ChatBindings.SERVER);
  await server.register(options.chat, {
    dispatch: merged.dispatch,
    principal: merged.principal,
  });

  const rest = await app.restServer;
  const handle = mountChatWebhooks(options.chat, rest.expressApp, merged);

  app.onStop(() => options.chat.shutdown());
  return handle;
}

/**
 * Lower-level: mount each `chat.webhooks.<adapter>` on an Express app. Bridges
 * AgentBack's Express request to the Chat SDK's fetch-native handler
 * (`(Request) => Promise<Response>`), preferring `req.rawBody` (see
 * {@link chatJsonVerify}).
 */
export function mountChatWebhooks(
  chat: ChatLike,
  expressApp: Express,
  options: Omit<InstallChatOptions, 'chat'> = {},
): ChatHttpHandle {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const waitUntil =
    options.waitUntil ??
    ((p: Promise<unknown>) =>
      void p.catch(err => log.error('chat background task failed: %s', err)));
  const paths: Record<string, string> = {};
  let warnedRawBody = false;

  for (const adapter of Object.keys(chat.webhooks)) {
    const path = options.paths?.[adapter] ?? `${basePath}/${adapter}`;
    paths[adapter] = path;
    const handler = chat.webhooks[adapter];

    expressApp.post(path, async (req: ExRequest, res: ExResponse) => {
      const rawBody = (req as ExRequest & {rawBody?: Buffer}).rawBody;
      if (!rawBody && !warnedRawBody) {
        warnedRawBody = true;
        log.warn(
          'no req.rawBody on %s — falling back to re-serialized JSON. ' +
            'Signature-verifying adapters (Slack/Teams) will reject this; ' +
            'construct the app with bodyParser.json.verify = chatJsonVerify.',
          path,
        );
      }
      const body: Uint8Array | string = rawBody
        ? new Uint8Array(rawBody)
        : JSON.stringify((req as ExRequest & {body?: unknown}).body ?? {});

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(','));
      }
      try {
        const webRes = await handler(
          new Request(`http://localhost${req.originalUrl}`, {
            method: 'POST',
            headers,
            body,
          }),
          {waitUntil},
        );
        res.status(webRes.status);
        webRes.headers.forEach((value, key) => res.setHeader(key, value));
        res.send(await webRes.text());
      } catch (err) {
        log.error('chat webhook %s failed: %s', path, err);
        res.status(500).send('chat webhook error');
      }
    });
    log.info('mounted chat webhook: POST %s', path);
  }
  return {paths};
}
