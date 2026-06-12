// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {bind, ContextTags} from '@agentback/context';
import {MCP_SERVER_TAG} from '../keys.js';

/**
 * Mark a class as a contributor of MCP tools/resources/prompts. The class
 * is bound with the `mcpServer` tag so MCPServer discovers it at start.
 */
export function mcpServer(name?: string): ClassDecorator {
  return bind({
    tags: {
      [ContextTags.NAME]: name,
      [MCP_SERVER_TAG]: true,
    },
  });
}
