// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-agents — the magical moment: an AI SDK agent calls the @tool classes
// you already wrote, with zero re-declaration. One Zod schema is the
// validator, the TS type, the OpenAPI/MCP contract, AND the agent's tool.
//
// Runs with NO network and NO API key by default (a deterministic mock model
// drives the loop). Set ANTHROPIC_API_KEY and add @ai-sdk/anthropic to switch
// to a real model — the AgentBack side is identical either way.

import {z} from 'zod';
import {isMain} from '@agentback/core';
import {mcpServer, MCPComponent, tool} from '@agentback/mcp';
import {RestApplication} from '@agentback/rest';
import {
  installAgent,
  toHostTools,
  AgentBindings,
  type AgentPort,
} from '@agentback/agents';
import {ToolLoopAgent} from 'ai';
import {mockForecastModel} from './mock-model.js';

// ── The app's existing tool surface (what every AgentBack app already has) ──

const ForecastIn = z.object({
  city: z.string().min(1).describe('City to forecast'),
});
const ForecastOut = z.object({
  city: z.string(),
  tempC: z.number(),
  summary: z.string(),
});

@mcpServer()
export class ForecastTools {
  @tool('forecast', {
    description: 'Get the weather forecast for a city.',
    input: ForecastIn,
    output: ForecastOut,
  })
  async forecast(
    input: z.infer<typeof ForecastIn>,
  ): Promise<z.infer<typeof ForecastOut>> {
    return {city: input.city, tempC: 21, summary: 'Clear skies'};
  }
}

// ── The agent: model loop + the app's own tools, projected ──

export async function main() {
  const app = new RestApplication({rest: {port: 0}});
  app.component(MCPComponent);
  app.service(ForecastTools);

  // Least privilege: name the tools the agent gets. Same Zod schema the MCP
  // server and OpenAPI doc already use — a sixth view of one source of truth.
  const tools = await toHostTools(app, {include: ['forecast']});

  const agent = new ToolLoopAgent({
    model: mockForecastModel(),
    tools,
  });

  // Optional: DI + lifecycle + metering. Not needed for this one-off turn,
  // but shown so the example doubles as the installAgent reference.
  installAgent(app, {agent});
  const injected = await app.get<AgentPort>(AgentBindings.AGENT.key);

  const result = await injected.generate({
    prompt: 'What is the forecast for Tokyo?',
  });

  console.log('\nAgent answer:', result.text);
  console.log(
    '\nSteps (the magical moment — YOUR @tool, called by the agent):',
  );
  for (const step of (result.steps ?? []) as Array<{
    toolCalls?: Array<{toolName: string; input: unknown}>;
    toolResults?: Array<{output: unknown}>;
  }>) {
    for (const call of step.toolCalls ?? []) {
      console.log(`  → ${call.toolName}(${JSON.stringify(call.input)})`);
    }
    for (const r of step.toolResults ?? []) {
      console.log(`  ← ${JSON.stringify(r.output)}`);
    }
  }

  await app.stop();
  return result;
}

if (isMain(import.meta)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
