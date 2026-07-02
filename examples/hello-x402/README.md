# hello-x402

> Monetize a REST route and an MCP tool with one decorator: `@price('$0.01')` + the x402 (HTTP 402) payment rail.

`@price` declares what a call costs, and two things consume it:

1. **Metering** — every call's `UsageEvent` carries `cost` + `units`, so the
   usage log is billing-ready (`StripeMeterSink` forwards it to Stripe metered
   billing unchanged).
2. **`installPriceGate(app, {rail})`** — unpaid calls are refused with a
   machine-actionable envelope: `code: 'payment_required'`, the x402 challenge
   under `challenge`, and a hint. Pay, retry, 200.

The priced surface is `GET /` (REST) and the `get_forecast` MCP tool; a free
`GET /teaser` shows the ungated path. For a self-contained demo the example
stands in an in-process x402 facilitator (it "verifies" a fixed blob and
"settles" with a fake tx hash). In production you drop the fake and point the
rail at a real facilitator — the resource-server code is identical.

## Run

```bash
pnpm build              # from the repo root
pnpm -F hello-x402 start
```

The startup log prints curl commands for the 402 challenge → pay → retry loop.
