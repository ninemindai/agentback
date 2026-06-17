// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {injectable} from '@agentback/core';

/**
 * A plain DI service. The point of the example: a chat handler reaches the same
 * services your REST routes and MCP tools would — one container, three surfaces.
 */
@injectable()
export class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}! — produced by GreetingService resolved through AgentBack DI`;
  }
}
