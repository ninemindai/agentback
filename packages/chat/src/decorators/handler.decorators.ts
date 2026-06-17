// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MethodDecoratorFactory} from '@agentback/metadata';
import {ChatKeys, type ChatEvent, type ChatHandlerMetadata} from '../keys.js';

/**
 * Subscribe a `@chatBot` method to a chat {@link ChatEvent}. The method is
 * invoked with whatever arguments the chat runtime passes for that event
 * (e.g. `(thread, message)` for `mention`/`message`, an event object for
 * `action`/`slashCommand`). Prefer the named convenience decorators below.
 */
export function onChatEvent(event: ChatEvent): MethodDecorator {
  return function (target, methodName, descriptor) {
    const meta: ChatHandlerMetadata = {event, methodName};
    MethodDecoratorFactory.createDecorator<ChatHandlerMetadata>(
      ChatKeys.HANDLER,
      meta,
      {decoratorName: `@on:${event}`},
    )(target, methodName, descriptor);
  };
}

/** Handle a new @-mention in an unsubscribed thread (`chat.onNewMention`). */
export const onMention = (): MethodDecorator => onChatEvent('mention');
/** Handle a message in a subscribed thread (`chat.onSubscribedMessage`). */
export const onMessage = (): MethodDecorator => onChatEvent('message');
/** Handle a direct message (`chat.onDirectMessage`). */
export const onDirectMessage = (): MethodDecorator =>
  onChatEvent('directMessage');
/** Handle an interactive action — button click, etc. (`chat.onAction`). */
export const onAction = (): MethodDecorator => onChatEvent('action');
/** Handle a reaction add/remove (`chat.onReaction`). */
export const onReaction = (): MethodDecorator => onChatEvent('reaction');
/** Handle a slash command (`chat.onSlashCommand`). */
export const onSlashCommand = (): MethodDecorator =>
  onChatEvent('slashCommand');
