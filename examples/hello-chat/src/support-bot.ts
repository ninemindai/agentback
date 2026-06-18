// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {inject, service} from '@agentback/core';
import {SecurityBindings, type UserProfile} from '@agentback/security';
import {
  chatBot,
  onMention,
  type ChatMessage,
  type ChatThread,
} from '@agentback/chat';
import {GreetingService} from './greeting.service.js';

/**
 * A chat handler authored as an AgentBack service: `@chatBot` makes it a DI
 * singleton discovered via the CHAT_HANDLERS extension point; `@onMention`
 * subscribes the method to the runtime's mention event. Constructor `@service`
 * injection works exactly as it does for a REST controller or `@tool` class.
 *
 * The trailing `@inject(SecurityBindings.USER)` param is the per-call principal
 * the `principal` resolver established at `installChat` (see index.ts) — chat
 * reads identity the same way REST and MCP do. It's a *method* inject because a
 * `@chatBot` is a singleton; a `{scope: TRANSIENT}` bot could take it in the
 * constructor instead.
 */
@chatBot()
export class SupportBot {
  constructor(@service(GreetingService) private greeting: GreetingService) {}

  @onMention()
  async greet(
    thread: ChatThread,
    message: ChatMessage,
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ): Promise<void> {
    const who = user?.name ?? message.text ?? 'there';
    await thread.post(this.greeting.greet(String(who)));
  }
}
