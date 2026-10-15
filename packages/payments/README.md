# @agentback/payments

> The `paid?` seam for REST/MCP calls — **x402** (per-call HTTP 402), **MPP**
> (pre-authorized sessions), and **Stripe** (usage-log metered billing).
> Orchestrates payment authorization; does not settle.

A policy enforcement point (PEP) asks three questions per call — `may-call?`
(policy), `paid?` (rail), `metered?` (billing). This package is the `paid?` seam.

Two kinds of rail, deliberately different shapes:

- **Gating rails** (`PaymentRail.authorize`) decide a call in real time — pay
  now or get a `402`: **x402** (Coinbase, per-call) and **MPP** (Stripe + Tempo,
  sessions).
- **Reporting rail**: **Stripe** metered billing doesn't gate; it forwards
  billable usage to Stripe, which invoices on its own cycle. It is a
  `UsageSink`, not a `PaymentRail` — "same units, different rail."

No funds are custodied and nothing settles on-chain in-process — every rail
delegates to an external facilitator/processor.

```bash
pnpm add @agentback/payments
```

## The rail interface

```ts
interface PaymentRail {
  name: string;
  authorize(
    ctx: PaymentContext,
  ): Promise<
    | {status: 'paid'; receipt: Receipt}
    | {status: 'payment_required'; challenge: PaymentChallenge}
  >;
}
```

## x402 (HTTP 402)

```ts
import {X402Rail, paymentMiddleware} from '@agentback/payments';

const rail = new X402Rail({
  facilitator, // external /verify + /settle (you provide)
  requirements: ctx => [
    {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '1000', // base units of the asset
      asset: '0xA0b8…', // USDC contract
      payTo: '0xYourMerchant',
      resource: ctx.resource,
    },
  ],
});

// Mount like the rate-limit / auth guards.
restServer.expressApp.post('/paid-route', paymentMiddleware(rail), handler);
```

Flow: a call with no `X-PAYMENT` header gets **`402`** + the `accepts`
requirements. A call that presents one is `verify`-ed and `settle`-d through the
injected `X402Facilitator`; on success the middleware sets
`X-PAYMENT-RESPONSE` (base64 settlement detail) and calls `next()`. Verify or
settle failure → `402` with an `error`.

The `X402Facilitator` is an interface (`verify` / `settle`) — inject a hosted or
self-hosted facilitator in production; inject a fake in tests (no chain, no
network). This package does not sign EIP-3009 authorizations or broadcast
transactions; that is the client's and the facilitator's job.

### Nano (XNO) beside USDC

`NanoFacilitator` adds Nano to an existing x402 rail without changing how the
other entries are handled: it wraps your current facilitator as `fallback`,
answers payments for network `nano:mainnet` itself, and hands every other
payment to the fallback untouched.

```ts
import {NanoFacilitator, X402Rail, nanoRequirement} from '@agentback/payments';

const rail = new X402Rail({
  facilitator: new NanoFacilitator({
    fallback: facilitator,
    replayStore: spentBlocks, // required: shared + durable, see below
  }),
  requirements: ctx => [
    usdcRequirement(ctx), // unchanged
    nanoRequirement({
      payTo:
        'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3',
      amountRaw: '10000000000000000000000000000', // 0.01 XNO (1 XNO = 10^30 raw)
      resource: ctx.resource,
      maxTimeoutSeconds: 300, // the default
    }),
  ],
});
```

The client publishes a send block to `payTo` first, then presents its hash as
an ordinary x402 payload (base64 JSON in `X-PAYMENT`):

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "nano:mainnet",
  "payload": {"blockHash": "<64 hex>"}
}
```

`verify` reads the block with one `block_info` call and accepts it only if it
is a confirmed state `send` to `payTo` of at least `maxAmountRequired` raw (the
`amount` the node reports, so the previous block, legacy or not, is never
read) that the node first saw no more than `maxTimeoutSeconds` ago (its
`local_timestamp`; a block with no usable timestamp is refused). Nano sends are
final once confirmed, so `settle` holds no key and broadcasts nothing: it
re-verifies and claims the hash in the `NanoReplayStore` so one block pays for
one call. `settle` judges recency at the time `verify` accepted the block, so a
send at the edge of the window is not refused between the two calls. The node defaults to `https://rpc.nano.to`; pass
`rpc: new FetchNanoRpc({url})` for your own node, or any `NanoRpc` in tests.

If the node cannot answer, `verify` and `settle` throw `NanoRpcUnavailableError`
(message `nano: node unavailable`, the node's error kept as `cause`) rather
than returning an invalid payment: the call fails closed with a server error,
no raw error text reaches the 402 body, and the payer can retry the same hash.

**The replay store is required, and it must be shared and durable.** It is
the only thing that stops one send block paying twice. A store that forgets on
restart, or is not shared by every instance behind the load balancer, lets a
block pay again for as long as it is inside `maxTimeoutSeconds`.
`InMemoryNanoReplayStore` is for tests and single-process development only.
Implement `has`/`claim` over a unique-keyed table or Redis (`SET key 1 NX`);
`claim` must be atomic. Keep claimed hashes forever if you can: the window is
measured by the node's `local_timestamp`, which the facilitator cannot check,
so only a store that never forgets is independent of what a node reports. A
store that expires entries must set `retentionSeconds`, and the facilitator
refuses any requirement whose `maxTimeoutSeconds + 120` exceeds it (60s of
node clock skew, 60s between our own instances).

**A block hash is a bearer proof.** Nothing in the send ties it to the caller
who presents it, so whoever presents a qualifying recent send first gets the
call. The recency window keeps old sends and unrelated donations to `payTo`
from being redeemed, but it does not stop someone watching `payTo` from
presenting a payer's fresh hash before the payer does. Closing that needs the
presenter to prove control of the paying account (a signature over a
server-issued nonce) or a server-issued per-challenge amount remembered until
it is paid; neither is implemented here. Keep `maxTimeoutSeconds` short and
prices small accordingly.

## MPP (sessions)

Instead of settling per call, MPP pre-authorizes a spending **session** and
streams micropayments against it — the natural fit for MCP, where a per-call
HTTP round-trip is awkward:

```ts
import {MppRail, InMemoryMppSessionStore} from '@agentback/payments';

const store = new InMemoryMppSessionStore();
store.open({id: 'sess_123', limit: 1000, spent: 0}); // processor opens this out of band

const rail = new MppRail({store, cost: () => 1}); // one unit per call
// callers present `X-MPP-SESSION: sess_123`; the rail decrements the budget.
restServer.expressApp.use(paymentMiddleware(rail));
```

Each call checks the session budget and (on success) consumes from it, returning
a receipt with `remaining`. A missing/expired/exhausted session yields a `402`
with an MPP challenge (`reason: 'no_session' | 'expired' | 'exhausted'`). An MPP
session is exactly the per-principal budget `@agentback/metering`'s
`QuotaService` models — so the rail is a thin layer over a session store. The
processor (Stripe + Tempo) opens and tops-up sessions; this package never
settles.

## MCP (payment-required as a tool error)

Over MCP (JSON-RPC) there is no HTTP `402`, so a paid tool called without
payment returns a **tool error** carrying the challenge in `_meta`; the agent
pays and retries with the proof. `PaidMCPServer` wires this — bind which tools
are paid (and how to read the proof) and install it as the MCP server:

```ts
import {
  PaidMCPServer,
  PaymentMcpBindings,
  MCP_PAYMENT_CHALLENGE_META,
} from '@agentback/payments';

app.server(PaidMCPServer, 'MCPServer');
app.bind(PaymentMcpBindings.OPTIONS).to({
  railFor: tool => (tool === 'premium_search' ? rail : undefined), // x402 or MPP
});
```

That's the whole wiring — **over MCP-over-HTTP it is end-to-end with no per-app
glue.** The proof travels in the request headers (`X-PAYMENT` / `X-MPP-SESSION`),
which the transport exposes via `MCPBindings.REQUEST_INFO`; `PaidMCPServer` reads
them automatically. (For stdio, or to override, bind an explicit proof at
`PaymentMcpBindings.REQUEST_PAYMENT`.)

A free tool passes straight through. A paid tool with no proof returns
`{isError: true, content: [...], _meta: {'payments/challenge': <challenge>}}` —
the agent reads `_meta[MCP_PAYMENT_CHALLENGE_META]`, pays, and retries. MPP's
pre-authorized session is the smoothest MCP rail (no per-call round-trip);
x402 works too via this retry loop.

The gate is also exposed directly — `gateMcpToolPayment(rail, ctx, run)` and
`paymentRequiredToolResult(challenge)` — if you wrap tool dispatch yourself.

## Stripe (usage-log metered billing)

The enterprise rail — fiat, no crypto, no per-call gating. It forwards billable
`UsageEvent`s (the ones `@agentback/metering` already produces) to
Stripe's metered billing, which invoices on its own cycle. It is a `UsageSink`,
not a `PaymentRail`:

```ts
import {StripeUsageReporter, StripeMeterSink} from '@agentback/payments';
import {CompositeUsageSink, JsonlUsageSink} from '@agentback/metering';

const reporter = new StripeUsageReporter({
  client, // wraps stripe.billing.meterEvents.create
  eventName: 'api_call', // your Stripe meter
  customerFor: p => lookupStripeCustomer(p.id), // principal → customer, or skip
});

// Stream: bill each call as it's recorded, alongside the durable audit log.
app
  .bind(MeteringBindings.SINK)
  .to(
    new CompositeUsageSink([
      new JsonlUsageSink('usage.jsonl'),
      new StripeMeterSink(reporter),
    ]),
  );

// …or batch: replay the durable log into Stripe on a schedule.
await reporter.report(await new JsonlUsageSink('usage.jsonl').read());
```

Only `status: 'ok'` events bill by default (denied/error/rate-limited are
skipped), a principal with no mapped customer is skipped, and each event's id is
the Stripe idempotency `identifier` — so re-reporting a log is safe.

## Composing with metering

`paid?` and `metered?` are complementary: `@agentback/metering`
records every call (the `metered?` answer and the audit log), and a rail gates
or bills the ones that must be paid for. A gated paid call still emits a
`UsageEvent`; a `402` emits one with `status: 'payment_required'`; and the
Stripe sink turns those same events into invoices.

## Status

Phase-2 in the go-to-market (payments stay dark until governance has earned the
in-path position) but built now: the seam is cheap to carry and lets a route or
tool node declare a rail without a code change later.
