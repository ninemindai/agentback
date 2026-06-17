// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding, BindingScope} from '@agentback/context';
import type {Component} from '@agentback/core';
import {ChatBindings} from './keys.js';
import {ChatServer} from './chat.server.js';

/**
 * Contributes {@link ChatServer} to an Application so {@link installChat} can
 * discover `@chatBot` handlers.
 *
 * @example
 *   const app = new RestApplication({
 *     rest: {bodyParser: {json: {verify: chatJsonVerify}}},
 *   });
 *   app.component(ChatComponent);
 *   app.service(SupportBot);          // @chatBot class
 *   await installChat(app, {chat});   // chat = new Chat({adapters})
 *   await app.start();
 */
export class ChatComponent implements Component {
  bindings = [
    Binding.bind(ChatBindings.SERVER.key)
      .toClass(ChatServer)
      .inScope(BindingScope.SINGLETON),
  ];
}
