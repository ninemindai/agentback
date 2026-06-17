// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {injectable, BindingScope, ContextTags} from '@agentback/context';
import type {TagMap} from '@agentback/context';
import {extensionFor} from '@agentback/core';
import {CHAT_HANDLERS} from '../keys.js';

/** Options for {@link chatBot}. */
export interface ChatBotOptions {
  /** Binding name (`ContextTags.NAME`). */
  name?: string;
  /**
   * Binding scope. Defaults to `SINGLETON` — a chat handler is typically a
   * stateless service whose per-request data arrives as the thread/message
   * arguments, so one shared instance is reused (its constructor `@inject`
   * dependencies resolve once).
   */
  scope?: BindingScope;
  /** Extra tags to merge onto the binding. */
  tags?: TagMap;
}

/**
 * Mark a class as a contributor of chat handlers. Built on `@injectable`, so the
 * class is a normal DI binding tagged `chatHandlers` — {@link ChatServer}
 * discovers it by that tag and resolves it (with constructor `@inject`) through
 * whatever binding registered it (`app.service`, a manual `bind`). Decorate its
 * methods with `@onMention()`, `@onMessage()`, etc.
 *
 * @example
 * ```ts
 * @chatBot()
 * class SupportBot {
 *   constructor(@service(GreetingService) private greet: GreetingService) {}
 *   @onMention()
 *   async greetUser(thread: ChatThread, message: ChatMessage) {
 *     await thread.post(this.greet.greet(message.text ?? 'there'));
 *   }
 * }
 * // app.service(SupportBot)
 * ```
 */
export function chatBot(
  nameOrOptions?: string | ChatBotOptions,
): ClassDecorator {
  const options: ChatBotOptions =
    typeof nameOrOptions === 'string'
      ? {name: nameOrOptions}
      : (nameOrOptions ?? {});
  return injectable(
    {
      scope: options.scope ?? BindingScope.SINGLETON,
      tags: {
        ...options.tags,
        ...(options.name ? {[ContextTags.NAME]: options.name} : {}),
      },
    },
    extensionFor(CHAT_HANDLERS),
  );
}
