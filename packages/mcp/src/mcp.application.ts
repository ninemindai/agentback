// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Application, ApplicationConfig} from '@agentback/core';
import {MCPComponent} from './mcp.component.js';

/**
 * Convenience MCP-only Application: pre-mounts {@link MCPComponent}.
 *
 * For a hybrid REST + MCP app, mount the component on a RestApplication
 * directly: `app.component(MCPComponent)`.
 */
export class MCPApplication extends Application {
  constructor(config?: ApplicationConfig) {
    super(config);
    this.component(MCPComponent);
  }
}
