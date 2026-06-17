// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {service} from '@agentback/core';
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
 */
@chatBot()
export class SupportBot {
  constructor(@service(GreetingService) private greeting: GreetingService) {}

  @onMention()
  async greet(thread: ChatThread, message: ChatMessage): Promise<void> {
    await thread.post(this.greeting.greet(message.text ?? 'there'));
  }
}
