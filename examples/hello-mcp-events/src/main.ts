// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RestServer} from '@agentback/rest';
import {createApp} from './application.js';

const app = await createApp({port: Number(process.env.PORT ?? 3000)});
await app.start();
const url = (await app.get<RestServer>('servers.RestServer')).url;
console.log(`hello-mcp-events: MCP endpoint at ${url}/mcp`);
console.log('  bearer tokens: demo-alice (docs:read), demo-bob (no scopes)');
