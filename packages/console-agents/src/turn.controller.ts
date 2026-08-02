// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {api, post, get, AgentError, ErrorCodes} from '@agentback/openapi';
import {inject} from '@agentback/core';
import {AgentBindings, type AgentPort} from '@agentback/agents';

/**
 * One step of an agent turn, flattened for the browser.
 *
 * The AI SDK's `steps` are richer than this, but the panel only renders what a
 * developer needs to see the loop work: what the model said, and which of
 * *their* tools it called with what. Anything deeper belongs in a trace
 * backend, not a dev console.
 */
const TurnStep = z.object({
  text: z.string().optional(),
  toolCalls: z
    .array(z.object({toolName: z.string(), input: z.unknown().optional()}))
    .optional(),
  toolResults: z
    .array(z.object({toolName: z.string(), output: z.unknown().optional()}))
    .optional(),
});

export const TurnIn = z.object({
  prompt: z.string().min(1).max(8000),
});

export const TurnOut = z.object({
  text: z.string(),
  steps: z.array(TurnStep),
});

export const StatusOut = z.object({
  /** Whether an agent is bound — the panel is inert without one. */
  available: z.boolean(),
  /** Tool names the agent can call, for the empty-state hint. */
  tools: z.array(z.string()),
});

/** Narrow the AI SDK's loosely-typed `steps` into {@link TurnStep} shape. */
function toSteps(raw: unknown): z.infer<typeof TurnStep>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(s => {
    const step = (s ?? {}) as Record<string, unknown>;
    const calls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    const results = Array.isArray(step.toolResults) ? step.toolResults : [];
    return {
      ...(typeof step.text === 'string' && step.text ? {text: step.text} : {}),
      ...(calls.length
        ? {
            toolCalls: calls.map(c => {
              const call = (c ?? {}) as Record<string, unknown>;
              return {
                toolName: String(call.toolName ?? 'unknown'),
                input: call.input,
              };
            }),
          }
        : {}),
      ...(results.length
        ? {
            toolResults: results.map(r => {
              const res = (r ?? {}) as Record<string, unknown>;
              return {
                toolName: String(res.toolName ?? 'unknown'),
                output: res.output,
              };
            }),
          }
        : {}),
    };
  });
}

/**
 * The console's agent playground: run **one** turn of the app's own agent
 * against the app's own tools.
 *
 * ## Why the turn runs here and not in the browser
 *
 * A model call needs a provider credential. Putting one in a page bundle
 * publishes it, so the browser only ever sends a prompt string; the key stays
 * in the server's environment where `installAgent` already reads it. That also
 * means the turn goes through the real `AgentBindings.AGENT` wrapper — quota
 * preflight, per-turn identity, metering — rather than a parallel path that
 * would drift from what production does.
 *
 * ## Per-turn identity
 *
 * `AgentBindings.AGENT` is TRANSIENT and reads `SecurityBindings.USER` from the
 * context it is resolved in. Injecting it into a **request-scoped controller**
 * is therefore what makes the console operator the turn's principal, rather
 * than baking whoever happened to boot the app. Do not hoist this to a
 * singleton.
 */
@api({basePath: '/console/agents/api'})
export class AgentPlaygroundController {
  constructor(
    @inject(AgentBindings.AGENT, {optional: true})
    private agent?: AgentPort,
  ) {}

  /**
   * Whether the panel can do anything. The console statically bundles this
   * page, so it is always *present*; without a bound agent it renders an
   * explanation instead of a prompt box. Reporting that is cheaper and clearer
   * than letting the first turn fail.
   */
  @get('/status', {response: StatusOut})
  status(): z.infer<typeof StatusOut> {
    return {
      available: Boolean(this.agent),
      tools: Object.keys(this.agent?.tools ?? {}).sort(),
    };
  }

  @post('/turn', {body: TurnIn, response: TurnOut})
  async turn(input: {
    body: z.infer<typeof TurnIn>;
  }): Promise<z.infer<typeof TurnOut>> {
    if (!this.agent) {
      throw new AgentError(
        'No agent is bound. Call `installAgent(app, {agent})` from ' +
          '@agentback/agents before installing the console.',
        {code: ErrorCodes.NOT_FOUND, status: 404, retryable: false},
      );
    }
    const result = await this.agent.generate({prompt: input.body.prompt});
    return {text: result.text ?? '', steps: toSteps(result.steps)};
  }
}
