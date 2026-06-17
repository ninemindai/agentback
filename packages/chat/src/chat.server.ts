// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ContextView} from '@agentback/context';
import {extensions} from '@agentback/core';
import {MetadataInspector} from '@agentback/metadata';
import {loggers} from '@agentback/common';
import {
  CHAT_HANDLERS,
  ChatKeys,
  EVENT_TO_RUNTIME_METHOD,
  type ChatHandlerMetadata,
} from './keys.js';
import type {ChatLike, ChatRuntimeHandler} from './port.js';

const log = loggers('agentback:chat');

/** One discovered handler: which class method handles which event. */
export interface ChatHandlerBinding {
  ctor: Function;
  bindingKey: string;
  meta: ChatHandlerMetadata;
}

/**
 * Discovers `@chatBot` classes and wires their `@on*` methods onto a chat
 * runtime ({@link ChatLike}).
 *
 * Discovery uses `@extensions.view(CHAT_HANDLERS)` — the extension-point-aware
 * `ContextView` over every class tagged `extensionFor(CHAT_HANDLERS)` by
 * `@chatBot`. The view's `bindings` give each contributor's `valueConstructor`
 * for **non-instantiating** metadata reads ({@link listHandlers}); the view's
 * `context` resolves each instance through its own binding (honoring
 * constructor `@inject`) only when wiring ({@link register}). The view is
 * reactive, so a `@chatBot` bound before {@link installChat} is always seen.
 *
 * Bound by {@link ChatComponent}; driven by {@link installChat}.
 */
export class ChatServer {
  constructor(
    @extensions.view(CHAT_HANDLERS)
    protected handlersView: ContextView<object>,
  ) {}

  /**
   * Every `@on*`-decorated method across all discovered `@chatBot` classes.
   * Reads class metadata only — does not resolve (instantiate) the handlers.
   */
  listHandlers(): ChatHandlerBinding[] {
    const out: ChatHandlerBinding[] = [];
    for (const b of this.handlersView.bindings) {
      const ctor = b.valueConstructor;
      if (typeof ctor !== 'function') continue;
      const handlers =
        MetadataInspector.getAllMethodMetadata<ChatHandlerMetadata>(
          ChatKeys.HANDLER,
          ctor.prototype,
        );
      if (!handlers) continue;
      for (const [methodName, meta] of Object.entries(handlers)) {
        if (!meta) continue;
        out.push({ctor, bindingKey: b.key, meta: {...meta, methodName}});
      }
    }
    return out;
  }

  /**
   * Resolve each `@chatBot` instance and subscribe its `@on*` methods to the
   * chat runtime. Instances are resolved through their own binding so
   * constructor `@inject` works; a singleton resolves once and is shared.
   * Handlers whose event the runtime does not support are skipped with a warn.
   */
  async register(chat: ChatLike): Promise<void> {
    // Resolve each contributor once, then wire all of its methods.
    const byKey = new Map<string, ChatHandlerBinding[]>();
    for (const h of this.listHandlers()) {
      const list = byKey.get(h.bindingKey);
      if (list) list.push(h);
      else byKey.set(h.bindingKey, [h]);
    }
    for (const [bindingKey, handlers] of byKey) {
      const instance =
        await this.handlersView.context.get<Record<string, ChatRuntimeHandler>>(
          bindingKey,
        );
      for (const {ctor, meta} of handlers) {
        const runtimeMethod = EVENT_TO_RUNTIME_METHOD[meta.event];
        const subscribe = chat[runtimeMethod] as
          | ((handler: ChatRuntimeHandler) => void)
          | undefined;
        if (typeof subscribe !== 'function') {
          log.warn(
            'chat runtime has no %s() for @%s on %s.%s — skipped',
            String(runtimeMethod),
            meta.event,
            ctor.name,
            String(meta.methodName),
          );
          continue;
        }
        const methodName = meta.methodName as string;
        subscribe.call(chat, (...args: unknown[]) =>
          instance[methodName].apply(instance, args),
        );
        log.info(
          'wired %s.%s -> chat.%s (%s)',
          ctor.name,
          methodName,
          String(runtimeMethod),
          meta.event,
        );
      }
    }
  }
}
