// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Context,
  ContextView,
  resolveInjectedArguments,
} from '@agentback/context';
import {extensions} from '@agentback/core';
import {MetadataInspector} from '@agentback/metadata';
import {loggers} from '@agentback/common';
import {SecurityBindings} from '@agentback/security';
import {
  CHAT_HANDLERS,
  ChatBindings,
  ChatKeys,
  EVENT_TO_RUNTIME_METHOD,
  type ChatDispatch,
  type ChatEvent,
  type ChatHandlerMetadata,
  type ChatPrincipalResolver,
} from './keys.js';
import type {
  ChatLike,
  ChatRuntimeHandler,
  ChatSender,
  ChatThread,
} from './port.js';

const log = loggers('agentback:chat');

/** Options for {@link ChatServer.register}. */
export interface ChatRegisterOptions {
  /** Sequential (default) or parallel handler execution. */
  dispatch?: ChatDispatch;
  /** Establishes `SecurityBindings.USER` per event from the parsed sender. */
  principal?: ChatPrincipalResolver;
}

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
   * Subscribe every `@chatBot`'s `@on*` methods to the chat runtime.
   *
   * One **composite** handler is registered per event, backed by the array of
   * that event's handlers, so delegation is ours: ordered + error-isolated,
   * `sequential` (default) or `parallel`. Each dispatch runs in a per-call child
   * context that binds the sender/thread/event and — via `options.principal` —
   * `SecurityBindings.USER`. Handlers are resolved through their own binding
   * against that child (scope-correct: a singleton stays shared and reads
   * per-call values via method `@inject`; a per-call-scoped bot reads them in
   * its constructor), and method-level `@inject` is woven from the same context.
   * Handlers whose event the runtime does not support are skipped with a warn.
   */
  async register(
    chat: ChatLike,
    options: ChatRegisterOptions = {},
  ): Promise<void> {
    const dispatch = options.dispatch ?? 'sequential';
    // Group decorated methods by event (each carries its binding + method, to
    // resolve scope-correctly per call).
    const byEvent = new Map<ChatEvent, BoundHandler[]>();
    for (const {ctor, bindingKey, meta} of this.listHandlers()) {
      const bound: BoundHandler = {
        label: `${ctor.name}.${String(meta.methodName)}`,
        ctor,
        bindingKey,
        methodName: meta.methodName as string,
      };
      const list = byEvent.get(meta.event);
      if (list) list.push(bound);
      else byEvent.set(meta.event, [bound]);
    }

    const parent = this.handlersView.context;
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
      subscribe.call(
        chat,
        makeComposite(parent, bound, event, dispatch, options.principal),
      );
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

/** A discovered handler the composite resolves and invokes per call. */
interface BoundHandler {
  label: string;
  ctor: Function;
  bindingKey: string;
  methodName: string;
}

/** Extract the sender + thread the runtime delivered for an event. */
function extractCallData(
  event: ChatEvent,
  args: unknown[],
): {sender?: ChatSender; thread?: ChatThread | null; raw: unknown} {
  if (event === 'mention' || event === 'message' || event === 'directMessage') {
    const [thread, message] = args as [
      ChatThread | undefined,
      {author?: ChatSender} | undefined,
    ];
    return {thread, sender: message?.author, raw: message};
  }
  const [evt] = args as [
    {user?: ChatSender; thread?: ChatThread | null} | undefined,
  ];
  return {thread: evt?.thread, sender: evt?.user, raw: evt};
}

/**
 * Build the single handler the runtime sees for an event. Backed by the array
 * of that event's handlers, it owns delegation: a per-call child context (with
 * sender/thread/event + the resolved principal) is created, every handler is
 * resolved + `@inject`-woven + invoked against it, errors are isolated, and the
 * context is closed when the dispatch settles.
 */
function makeComposite(
  parent: Context,
  bound: BoundHandler[],
  event: ChatEvent,
  dispatch: ChatDispatch,
  principal?: ChatPrincipalResolver,
): ChatRuntimeHandler {
  const onError = (h: BoundHandler, err: unknown): void => {
    log.error('chat handler %s (@%s) threw: %s', h.label, event, err);
  };

  const invoke = async (
    h: BoundHandler,
    ctx: Context,
    args: unknown[],
  ): Promise<void> => {
    // Event args fill the leading (non-@inject) slots; method-level @inject
    // params are resolved from the per-call context.
    const woven = await resolveInjectedArguments(
      h.ctor.prototype,
      h.methodName,
      ctx,
      undefined,
      args,
    );
    const instance = await ctx.get<Record<string, Function>>(h.bindingKey);
    await instance[h.methodName].apply(instance, woven);
  };

  return async (...args: unknown[]) => {
    const ctx = new Context(parent, 'chat.request');
    try {
      const {sender, thread, raw} = extractCallData(event, args);
      ctx.bind(ChatBindings.EVENT).to(raw);
      if (sender !== undefined) ctx.bind(ChatBindings.SENDER).to(sender);
      if (thread != null) ctx.bind(ChatBindings.THREAD).to(thread);
      if (principal) {
        const user = await principal(sender, {event, thread, raw});
        if (user) ctx.bind(SecurityBindings.USER).to(user);
      }

      if (dispatch === 'parallel') {
        const results = await Promise.allSettled(
          bound.map(h => invoke(h, ctx, args)),
        );
        results.forEach((r, i) => {
          if (r.status === 'rejected') onError(bound[i], r.reason);
        });
      } else {
        for (const h of bound) {
          try {
            await invoke(h, ctx, args);
          } catch (err) {
            onError(h, err);
          }
        }
      }
    } finally {
      ctx.close();
    }
  };
}
