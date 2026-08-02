// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-agents (console) — the same agent as `main.ts`, but left running behind
// the unified console so you can drive it from a browser instead of a script.
//
//   pnpm -F hello-agents console   →   open http://127.0.0.1:3000/console/#/agents
//
// Uses the same mock model as `main.ts`, so this needs **no API key and no
// network**. Swap `mockForecastModel()` for a real provider and the panel
// starts spending money — which is why the playground is off by default.

import {isMain} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installConsole, defaultFeatures} from '@agentback/console';
import {agentsConsoleFeature} from '@agentback/console-agents';
import {installAgent, toHostTools} from '@agentback/agents';
import {ToolLoopAgent} from 'ai';
import {ForecastTools} from './main.js';
import {mockForecastModel} from './mock-model.js';

export async function main(port = 3000): Promise<RestApplication> {
  const app = new RestApplication({rest: {port}});
  app.component(MCPComponent);
  app.service(ForecastTools);

  const agent = new ToolLoopAgent({
    model: mockForecastModel(),
    tools: await toHostTools(app, {include: ['forecast']}),
  });

  // The panel resolves `AgentBindings.AGENT` per request, so this binding is
  // what it runs — there is no second, console-only agent path to drift.
  installAgent(app, {agent});

  await installConsole(app, {
    // `installConsole` refuses to mount without a stated auth posture, and
    // this panel is the reason that matters most: every other panel only
    // *reads* the app, this one runs its tools. Local demo, so opt out
    // explicitly — never do this on anything reachable.
    unsafeAllowUnauthenticated: true,
    features: [
      ...defaultFeatures(),
      // Opt-in: a turn executes real tools as the console operator.
      agentsConsoleFeature({enabled: true}),
    ],
  });

  await app.start();
  const url = (await app.restServer).url;
  console.log(`hello-agents console: ${url}/console/#/agents`);
  console.log('  Try: "What is the forecast for Tokyo?"');
  console.log('  Mock model — no API key, no network.');
  return app;
}

if (isMain(import.meta)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
