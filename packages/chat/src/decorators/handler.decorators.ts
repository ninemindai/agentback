// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MethodDecoratorFactory} from '@agentback/metadata';
import {ChatKeys, type ChatEvent, type ChatHandlerMetadata} from '../keys.js';
import type {
  ChatActionEvent,
  ChatMessage,
  ChatReactionEvent,
  ChatSlashCommandEvent,
  ChatThread,
} from '../port.js';

// Return type is `any` (not `unknown`) on purpose: `TypedPropertyDescriptor<T>`
// is invariant in `T` (it has both `value` and `set`), so a `=> unknown`
// constraint would reject a method returning `Promise<void>`. `any` is the same
// trick `@tool` uses to keep the descriptor check on the *parameters*.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Awaitable = any;

/** Handlers for message-shaped events: `(thread, message)`. */
export type ChatMessageHandler = (
  thread: ChatThread,
  message: ChatMessage,
) => Awaitable;

/**
 * A method decorator that constrains the decorated method to `Fn`. Like
 * `@tool`, the constraint lives on the `TypedPropertyDescriptor`, so a method
 * whose signature doesn't match errors precisely at the `@on*` line. Handlers
 * receive exactly the event arguments (no method-level `@inject` weaving), so
 * the signature is exact — a method may take fewer parameters, but not more.
 */
type HandlerDecorator<Fn> = (
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<Fn>,
) => void;

/** Shared runtime: record `{event, methodName}` as method metadata. */
function handlerDecorator(event: ChatEvent) {
  return function (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void {
    const meta: ChatHandlerMetadata = {event, methodName: propertyKey};
    MethodDecoratorFactory.createDecorator<ChatHandlerMetadata>(
      ChatKeys.HANDLER,
      meta,
      {decoratorName: `@on:${event}`},
    )(target, propertyKey, descriptor);
  };
}

/**
 * Subscribe a `@chatBot` method to an arbitrary chat {@link ChatEvent}. The
 * untyped escape hatch — the method receives whatever the runtime passes for
 * that event. Prefer the named, signature-checked decorators below.
 */
export function onChatEvent(event: ChatEvent): MethodDecorator {
  return handlerDecorator(event);
}

/** Handle a new @-mention in an unsubscribed thread (`chat.onNewMention`). */
export function onMention(): HandlerDecorator<ChatMessageHandler> {
  return handlerDecorator('mention');
}
/** Handle a message in a subscribed thread (`chat.onSubscribedMessage`). */
export function onMessage(): HandlerDecorator<ChatMessageHandler> {
  return handlerDecorator('message');
}
/** Handle a direct message (`chat.onDirectMessage`). */
export function onDirectMessage(): HandlerDecorator<ChatMessageHandler> {
  return handlerDecorator('directMessage');
}
/** Handle an interactive action — button click, etc. (`chat.onAction`). */
export function onAction(): HandlerDecorator<
  (event: ChatActionEvent) => Awaitable
> {
  return handlerDecorator('action');
}
/** Handle a reaction add/remove (`chat.onReaction`). */
export function onReaction(): HandlerDecorator<
  (event: ChatReactionEvent) => Awaitable
> {
  return handlerDecorator('reaction');
}
/** Handle a slash command (`chat.onSlashCommand`). */
export function onSlashCommand(): HandlerDecorator<
  (event: ChatSlashCommandEvent) => Awaitable
> {
  return handlerDecorator('slashCommand');
}
