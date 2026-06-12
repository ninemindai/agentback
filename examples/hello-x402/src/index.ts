// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Hello, @price — monetize a REST route and an MCP tool with one decorator.
//
// `@price('$0.01')` declares what a call costs. Two things consume it:
//   1. Metering: every call's UsageEvent carries `cost` + `units`, so the
//      usage log is billing-ready (StripeMeterSink forwards it to Stripe
//      metered billing unchanged).
//   2. installPriceGate(app, {rail}): unpaid calls are refused with the
//      machine-actionable envelope — `code: 'payment_required'`, the x402
//      challenge under `challenge`, and a hint. Pay, retry, 200.
//
// For a self-contained demo this stands in an in-process x402 facilitator (it
// "verifies" a fixed blob and "settles" with a fake tx hash). In production
// you DROP the fake and point the rail at a real facilitator; the resource
// server code is identical.

import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {isMain} from '@agentback/core';
import {mcpServer, tool, MCPComponent} from '@agentback/mcp';
import {
  price,
  MeteringComponent,
  MeteringBindings,
  InMemoryUsageSink,
} from '@agentback/metering';
import {
  X402Rail,
  installPriceGate,
  type X402Facilitator,
} from '@agentback/payments';

const Premium = z.object({data: z.string(), servedAt: z.string()});
const ForecastIn = z.object({city: z.string().min(1)});
const ForecastOut = z.object({city: z.string(), forecast: z.string()});

@api({basePath: '/premium'})
@mcpServer()
class PremiumService {
  // A paid REST route: one decorator prices it, the gate enforces it.
  @price('$0.01')
  @get('/', {response: Premium})
  async data(): Promise<z.infer<typeof Premium>> {
    return {data: '🔓 premium widget data', servedAt: new Date().toISOString()};
  }

  // A paid MCP tool: same decorator, same rail, same usage log.
  @price('$0.001')
  @tool('get_forecast', {
    description: 'Returns the paid forecast for a city.',
    input: ForecastIn,
    output: ForecastOut,
  })
  async forecast(
    input: z.infer<typeof ForecastIn>,
  ): Promise<z.infer<typeof ForecastOut>> {
    return {city: input.city, forecast: 'sunny, 23°C'};
  }

  // Free routes pass through the gate untouched.
  @get('/teaser', {response: Premium})
  async teaser(): Promise<z.infer<typeof Premium>> {
    return {data: 'free sample', servedAt: new Date().toISOString()};
  }
}

// ---------------------------------------------------------------------------
// Stand-in x402 facilitator (demo only). A real facilitator verifies the
// signed EIP-3009 authorization and broadcasts the USDC transfer on-chain.
// ---------------------------------------------------------------------------
const VALID_PAYMENT = 'VALID-PAYMENT-BLOB';
const facilitator: X402Facilitator = {
  verify: async payment =>
    payment === VALID_PAYMENT
      ? {valid: true}
      : {valid: false, reason: 'invalid payment authorization'},
  settle: async () => ({
    success: true,
    payload: {txHash: '0xdeadbeef', network: 'base-sepolia'},
  }),
};

// The asked amount derives from the @price on the gated operation — no
// parallel price table. ($0.01 → 10000 USDC base units, 6 decimals.)
const rail = new X402Rail({
  facilitator,
  requirements: ctx => [
    {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: ctx.price
        ? String(Math.round(Number(ctx.price.amount) * 1e6))
        : '10000',
      asset: '0xUSDC',
      payTo: '0xMerchant',
      resource: ctx.resource,
      description: ctx.price
        ? `${ctx.price.amount} ${ctx.price.currency} per call`
        : 'Premium data',
      maxTimeoutSeconds: 60,
    },
  ],
});

async function main() {
  const app = new RestApplication({});
  app
    .configure('servers.RestServer')
    .to({port: Number(process.env.PORT ?? 3000), host: '127.0.0.1'});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({transports: {stdio: false}});

  // Order matters: metering first (outermost hook), then the gate — so
  // refused calls log as 'payment_required' and are never billed.
  app.component(MeteringComponent);
  installPriceGate(app, {rail});

  app.restController(PremiumService);
  app.service(PremiumService);

  await app.start();
  const server = await app.restServer;
  console.log(`hello-x402 listening at ${server.url}`);
  console.log(
    `  GET ${server.url}/premium/                                  → 402 {error: {code: 'payment_required', challenge, hint}}`,
  );
  console.log(
    `  GET ${server.url}/premium/ -H 'x-payment: ${VALID_PAYMENT}'  → 200 + x-payment-response receipt`,
  );
  console.log(
    `  GET ${server.url}/premium/teaser                            → 200 (free, no gate)`,
  );

  // The usage log is billing-ready: priced calls carry cost + units.
  const sink = (await app.get(MeteringBindings.SINK)) as InMemoryUsageSink;
  process.on('SIGINT', () => {
    console.log('\nusage log:');
    for (const e of sink.all()) {
      console.log(
        `  ${e.at} ${e.surface} ${e.operation} ${e.status}` +
          (e.cost ? ` ${e.cost.amount} ${e.cost.currency}` : ''),
      );
    }
    process.exit(0);
  });
}

if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
