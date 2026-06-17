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
  type ChatDispatch,
  type ChatEvent,
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
   *
   * One **composite** handler is registered per event, backed by the array of
   * that event's handlers — so delegation is ours: ordered + error-isolated,
   * `sequential` (default) or `parallel` per {@link ChatDispatch}.
   */
  async register(
    chat: ChatLike,
    dispatch: ChatDispatch = 'sequential',
  ): Promise<void> {
    // 1. Group decorated methods by their binding so each contributor resolves
    //    once, then bind each method to its resolved instance, grouped by event.
    const byKey = new Map<string, ChatHandlerBinding[]>();
    for (const h of this.listHandlers()) {
      const list = byKey.get(h.bindingKey);
      if (list) list.push(h);
      else byKey.set(h.bindingKey, [h]);
    }
    const byEvent = new Map<ChatEvent, BoundHandler[]>();
    for (const [bindingKey, handlers] of byKey) {
      const instance =
        await this.handlersView.context.get<Record<string, ChatRuntimeHandler>>(
          bindingKey,
        );
      for (const {ctor, meta} of handlers) {
        const methodName = meta.methodName as string;
        const bound: BoundHandler = {
          label: `${ctor.name}.${methodName}`,
          invoke: (...args) => instance[methodName].apply(instance, args),
        };
        const list = byEvent.get(meta.event);
        if (list) list.push(bound);
        else byEvent.set(meta.event, [bound]);
      }
    }

    // 2. Register ONE composite handler per event. The composite — not the
    //    runtime's dispatch loop — owns delegation, so ordering and error
    //    isolation are ours: a throwing handler is logged and skipped, never
    //    aborting its siblings (and the rejection never reaches the runtime).
    for (const [event, bound] of byEvent) {
      const runtimeMethod = EVENT_TO_RUNTIME_METHOD[event];
      const subscribe = chat[runtimeMethod] as
        | ((handler: ChatRuntimeHandler) => void)
        | undefined;
      if (typeof subscribe !== 'function') {
        log.warn(
          'chat runtime has no %s() for @%s — %d handler(s) skipped',
          String(runtimeMethod),
          event,
          bound.length,
        );
        continue;
      }
      subscribe.call(chat, makeComposite(bound, event, dispatch));
      log.info(
        'wired %d handler(s) -> chat.%s (@%s, %s)',
        bound.length,
        String(runtimeMethod),
        event,
        dispatch,
      );
    }
  }
}

/** One resolved handler the composite delegates to. */
interface BoundHandler {
  label: string;
  invoke: ChatRuntimeHandler;
}

/**
 * Build the single handler the runtime sees for an event. Backed by the array
 * of that event's handlers, it owns delegation: errors are always isolated (a
 * throwing handler is logged, never aborting siblings), run `sequential`
 * (ordered) or `parallel` (`Promise.allSettled`).
 */
function makeComposite(
  bound: BoundHandler[],
  event: ChatEvent,
  dispatch: ChatDispatch,
): ChatRuntimeHandler {
  const onError = (h: BoundHandler, err: unknown): void => {
    log.error('chat handler %s (@%s) threw: %s', h.label, event, err);
  };
  if (dispatch === 'parallel') {
    return async (...args: unknown[]) => {
      const results = await Promise.allSettled(
        bound.map(h => h.invoke(...args)),
      );
      results.forEach((r, i) => {
        if (r.status === 'rejected') onError(bound[i], r.reason);
      });
    };
  }
  return async (...args: unknown[]) => {
    for (const h of bound) {
      try {
        await h.invoke(...args);
      } catch (err) {
        onError(h, err);
      }
    }
  };
}
