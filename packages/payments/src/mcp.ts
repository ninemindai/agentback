// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey, type Context} from '@agentback/context';
import {MCPBindings, MCPServer, type ToolBinding} from '@agentback/mcp';
import type {PaymentChallenge, PaymentContext, PaymentRail} from './types.js';

/** `_meta` key under which a payment challenge is carried on a tool error. */
export const MCP_PAYMENT_CHALLENGE_META = 'payments/challenge';

export interface PaidToolOptions {
  /** Which rail (if any) gates a tool by name. `undefined` → a free tool. */
  railFor: (toolName: string) => PaymentRail | undefined;
  /**
   * Build the payment-proof {@link PaymentContext} for a call. Default reads the
   * partial bound at {@link PaymentMcpBindings.REQUEST_PAYMENT} (set by the
   * mcp-http layer from headers, or by the caller) and falls back to the tool
   * name as the resource.
   */
  contextFor?: (
    ctx: Context,
    toolName: string,
  ) => PaymentContext | Promise<PaymentContext>;
}

export namespace PaymentMcpBindings {
  /** The {@link PaidToolOptions} the paid server consults. */
  export const OPTIONS = BindingKey.create<PaidToolOptions>(
    'payments.mcp.options',
  );
  /** Per-request payment proof (e.g. `{paymentHeader}` / `{sessionId}`). */
  export const REQUEST_PAYMENT = BindingKey.create<Partial<PaymentContext>>(
    'payments.mcp.requestPayment',
  );
}

export interface McpPaymentToolResult {
  isError: true;
  content: {type: 'text'; text: string}[];
  _meta: Record<string, unknown>;
}

/** Human-readable summary of what the caller must do to pay. */
function paymentRequiredText(challenge: PaymentChallenge): string {
  if (challenge.rail === 'x402') {
    const n = challenge.accepts.length;
    return `Payment required. Pay via x402 (${n} option${n === 1 ? '' : 's'} in _meta.${MCP_PAYMENT_CHALLENGE_META}) and retry this tool call with the payment.`;
  }
  return `Payment required: ${challenge.reason}. Open or renew an MPP session and retry this tool call (see _meta.${MCP_PAYMENT_CHALLENGE_META}).`;
}

/**
 * Shape a payment challenge as an MCP tool **error result** — `isError: true`
 * content the agent reads, plus the structured challenge under
 * `_meta['{@link MCP_PAYMENT_CHALLENGE_META}']`. This is the MCP analogue of an
 * HTTP `402`: there is no status code over JSON-RPC, so payment-required rides
 * back as a tool error the agent can act on (pay, then retry).
 */
export function paymentRequiredToolResult(
  challenge: PaymentChallenge,
): McpPaymentToolResult {
  return {
    isError: true,
    content: [{type: 'text', text: paymentRequiredText(challenge)}],
    _meta: {[MCP_PAYMENT_CHALLENGE_META]: challenge},
  };
}

/**
 * Run a tool only if the call is paid for. On a `paid` verdict `run` executes
 * and its result is returned untouched; on `payment_required` the tool body is
 * skipped and a {@link paymentRequiredToolResult} is returned instead — carried
 * to the client as a tool error.
 */
export async function gateMcpToolPayment(
  rail: PaymentRail,
  ctx: PaymentContext,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const verdict = await rail.authorize(ctx);
  if (verdict.status === 'paid') return run();
  return paymentRequiredToolResult(verdict.challenge);
}

/** First value of a possibly-array header, case-insensitively. */
function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find(k => k.toLowerCase() === name);
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Default {@link PaidToolOptions.contextFor}. Prefers an explicit proof bound at
 * {@link PaymentMcpBindings.REQUEST_PAYMENT}; otherwise reads `X-PAYMENT` /
 * `X-MPP-SESSION` straight from the MCP request headers
 * ({@link MCPBindings.REQUEST_INFO}) — so an MCP-over-HTTP deployment needs no
 * per-app glue: the headers a caller sends reach the rail automatically.
 */
export async function defaultContextFor(
  ctx: Context,
  toolName: string,
): Promise<PaymentContext> {
  const explicit = await ctx.get(PaymentMcpBindings.REQUEST_PAYMENT, {
    optional: true,
  });
  if (explicit) {
    return {
      method: 'tools/call',
      resource: explicit.resource ?? toolName,
      paymentHeader: explicit.paymentHeader,
      sessionId: explicit.sessionId,
    };
  }
  const info = await ctx.get(MCPBindings.REQUEST_INFO, {optional: true});
  const headers = info?.headers ?? {};
  return {
    method: 'tools/call',
    resource: toolName,
    paymentHeader: header(headers, 'x-payment'),
    sessionId: header(headers, 'x-mpp-session'),
  };
}

/**
 * {@link MCPServer} that gates configured tools behind a {@link PaymentRail}.
 * Bind {@link PaymentMcpBindings.OPTIONS} (which tools are paid, and how to read
 * the payment proof) and install this as the MCP server. An unpaid call to a
 * paid tool returns a payment-required tool error carrying the challenge; the
 * agent pays and retries with the proof. Tools with no rail pass straight
 * through, so it is safe to install unconditionally.
 */
export class PaidMCPServer extends MCPServer {
  /** Seam over `super.dispatchTool`, overridable in tests. */
  protected async dispatchToolBase(
    tool: ToolBinding,
    input: unknown,
    ctx: Context,
  ): Promise<unknown> {
    return super.dispatchTool(tool, input, ctx);
  }

  protected override async dispatchTool(
    tool: ToolBinding,
    input: unknown,
    ctx: Context = this.context,
  ): Promise<unknown> {
    const options = await this.context.get(PaymentMcpBindings.OPTIONS, {
      optional: true,
    });
    const rail = options?.railFor(tool.meta.name);
    if (!rail) return this.dispatchToolBase(tool, input, ctx);

    const contextFor = options?.contextFor ?? defaultContextFor;
    const pctx = await contextFor(ctx, tool.meta.name);
    return gateMcpToolPayment(rail, pctx, () =>
      this.dispatchToolBase(tool, input, ctx),
    );
  }
}
