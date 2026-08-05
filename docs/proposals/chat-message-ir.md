# Proposal: message IR for `@agentback/chat` — rich, agent-emittable chat UI

**Status:** draft / design sketch
**Extends:** [E-1 Chat channels](chat-channels.md) (`@agentback/chat`, shipped 0.4.0)
**Backing library:** [Vercel Chat SDK](https://github.com/vercel/chat) `>= 4.33` — its `ChatElement` card vocabulary
**Prior art studied:** CopilotKit `@copilotkit/channels-ui` (JSX runtime + IR + per-platform renderers, evaluated 2026-08); OpenTag's inline generative UI (evaluated 2026-06)

## Thesis

`@agentback/chat` handlers can only `thread.post(text | stream)` today — the
one capability gap both CopilotKit evaluations flagged. Closing it does **not**
mean building what `channels-ui` built. The Chat SDK already ships the
expensive half: a cross-platform card vocabulary (`Card`, `Section`, `Fields`,
`Table`, `Actions`, `Button`, `Select`, `Modal`, …) with per-platform
renderers — Slack Block Kit, Teams Adaptive Cards, Google Chat Card v2 —
including the per-platform limit/markdown grind. `thread.post()` accepts a
`ChatElement` **today**, and our port's `post(content: unknown)` already passes
one through untyped.

What is actually missing is the AgentBack layer on top:

1. **Discoverability + typing** — the port and README never mention rich
   content; `ChatActionEvent` omits the fields a button callback needs
   (`value`, `messageId`, `openModal`).
2. **An agent-emittable authoring path** — a Zod-defined message IR, so a
   model (via `@tool` output or AI SDK structured output) can *return a card
   as validated JSON*. `channels-ui` requires a human writing TSX; a Zod IR is
   the projection-native equivalent and the one piece with no upstream
   analogue.
3. **Typed action routing** — `@onAction()` today receives every click;
   rich UI wants per-button dispatch with a validated payload.
4. **The HITL bridge** — a `confirm:` tool rendered as an in-thread
   Approve/Reject card: a third *presentation* of the existing confirmation
   mechanism, not a new one.

One sentence of positioning: **the Zod schema stays the single source of
truth, and a chat card becomes one more projection of it** — the same thesis
as OpenAPI/MCP/CLI/OKF, pointed at Block Kit.

## What we deliberately do NOT build

- **No renderer.** Block Kit / Adaptive Cards / Google Chat emission is the
  Chat SDK's job. If a platform renders a card badly, that is an upstream bug;
  we do not fork the budget/limits layer. (This is what makes the proposal
  small. `channels-slack`'s renderer + clamping + mrkdwn conversion is most of
  that package.)
- **No JSX runtime.** The Chat SDK already offers both a function API and its
  own `jsxImportSource: "chat"`. Users who want TSX authoring use the SDK's;
  AgentBack adds nothing. Our authoring surface is JSON-shaped (Zod-validated
  objects) precisely because models emit JSON, not JSX.
- **No content-stable handler binding.** `channels-ui`'s cleverest machinery —
  persisting `{component, props, path}` snapshots and re-rendering to
  re-derive an `onClick` closure after a restart — exists because their
  handlers are *closures inside JSX*. Ours are **decorated methods on DI
  services**: named code, resolved through the container, durable across
  restarts by construction. The entire tier-1/tier-2/tier-3 durability scheme
  dissolves; only oversized action payloads need indirection (Phase 3).
- **No dependency on `chat`.** The runtime dep policy from E-1 holds: the IR
  compiler emits plain objects that *structurally satisfy* `ChatElement`; a
  **devDependency** conformance test pins the fit (see Risks).

## Shape

All in the existing package — no new workspace member. Rough sizes are
guesses to anchor review, not commitments.

```
packages/chat/src/
  port.ts        (extend)  richer ChatActionEvent subset; ChatPostable alias
  message.ts     (new)     Zod IR: chatMessage/chatCard/chatAction… (~150 LoC)
  compile.ts     (new)     toChatElement(ir): IR → Chat-SDK-shaped objects (~80 LoC)
  decorators/    (extend)  @onAction('id', {value?: ZodType}) filtered form
  action-store.ts (new, P3) payload indirection port (ConfirmationStore-shaped)
```

## Phase 1 — surface what already works (port + docs, no new machinery)

Extend the hand-written structural subsets in `port.ts`:

```ts
/** Interactive action — button click, select, modal submit. */
export interface ChatActionEvent {
  readonly actionId?: string;
  readonly value?: string; // Button's payload, verbatim
  readonly messageId?: string; // the message carrying the card
  readonly triggerId?: string; // some platforms need it for modals
  readonly thread?: ChatThread | null;
  readonly user?: ChatSender;
  openModal?(modal: unknown): Promise<{viewId: string} | undefined>;
}
```

Then document the capability that exists today — a `@chatBot` posting a card
via the SDK's own builders:

```ts
import {Card, Text, Actions, Button} from 'chat'; // user's dep, not ours

@onMention()
async handle(thread: ChatThread, message: ChatMessage) {
  await thread.post(
    Card({
      title: `Ticket ${id}`,
      children: [
        Text(`Priority: ${priority}`),
        Actions([
          Button({id: 'approve', label: 'Approve', style: 'primary', value: id}),
          Button({id: 'reject', label: 'Reject', style: 'danger', value: id}),
        ]),
      ],
    }),
  );
}

@onAction()
async onClick(event: ChatActionEvent) {
  if (event.actionId === 'approve') { /* … */ }
}
```

Deliverables: port extension, README section, `hello-chat` example gains a
card + button round trip. **Zero new runtime code paths** — this phase is
pure exposure of Chat SDK capability through the existing seams.

## Phase 2 — the Zod IR (the AgentBack-native piece)

A Zod vocabulary mirroring the element set, plus a compiler to the Chat SDK
shape:

```ts
// message.ts (sketch — exact fields pinned by the conformance test)
export const chatText = z.object({
  type: z.literal('text'),
  content: z.string(),
  style: z.enum(['plain', 'bold', 'muted']).optional(),
});
export const chatButton = z.object({
  type: z.literal('button'),
  id: z.string(),
  label: z.string(),
  style: z.enum(['primary', 'danger', 'default']).optional(),
  value: z.string().max(2000).optional(),
});
// …chatImage, chatDivider, chatFields, chatTable, chatSelect, chatActions…
export const chatCard = z.object({
  type: z.literal('card'),
  title: z.string().optional(),
  children: z.array(chatCardChild),
});
export const chatMessage = z.union([z.string(), chatCard]);

// compile.ts
export function toChatElement(ir: z.infer<typeof chatMessage>): unknown;
```

Why a *second* vocabulary when the SDK has one? Three consumers the SDK's
TypeScript-only types cannot serve:

1. **Models.** `@tool({output: TriageCard})` where `TriageCard` embeds
   `chatCard` — the agent *returns UI as data*, output-validated by the
   existing pipeline, and the chat handler just
   `thread.post(toChatElement(result.card))`. This is the "agent draws its
   own reply" story `channels-ui` cannot tell without a human-authored
   component, and no schema-first competitor has it.
2. **The boundary.** A card assembled from model output or user input is
   validated *before* it hits a platform API, with Zod issues instead of an
   opaque platform 400.
3. **The graph.** Registered via `bindSchema`, the IR joins schema-explorer /
   OKF — chat UI becomes a visible projection of the schema graph like every
   other surface.

It also preserves the E-1 port discipline: handlers can author rich messages
without importing `chat` types. `port.ts` is already a hand-written subset of
the SDK's *runtime* surface; the IR extends the same discipline to *content*.

Example upgrade: `hello-chat` gains a `@tool` whose output embeds a card and
a bot that posts it — one schema, answered as JSON on MCP and as Block Kit in
Slack.

## Phase 3 — typed action routing + the confirm bridge

**Routing.** A filtered decorator form, backward compatible with the bare one:

```ts
@onAction('approve', {value: TicketRef}) // value: Zod, parsed from the string payload
async approve(event: ChatActionEvent, ref: z.infer<typeof TicketRef>) { … }
```

Dispatch matches `event.actionId` (bare `@onAction()` keeps receiving
everything, ordered after the filtered matches). The `value` schema parses
`JSON.parse(event.value)` — with the platform caveat below.

**Payload indirection.** `value` is a string with per-platform ceilings
(Slack ~2000 chars; Telegram's `callback_data` is 64 **bytes**). For payloads
beyond the floor, mint a token and store the payload server-side — the exact
`ConfirmationStore` shape (single-use, TTL'd): `value` carries the token,
dispatch resolves it. In-memory default, bring-your-own (Redis) for
multi-instance — same posture as `MCPBindings.CONFIRMATION_STORE`, and the
same restart caveat, stated plainly.

**Confirm bridge.** A helper that renders a pending `confirm:` tool
confirmation as a card — Approve/Reject buttons whose `value` carries the
already-issued confirmation token — and an `@onAction` route that completes
the round trip through the **existing** `ConfirmationStore` authority. Era
note from the MCP side applies verbatim: the button proves a round trip
happened *and* which button was pressed; the store still enforces single-use,
TTL, and input fingerprint. This makes chat the third presentation of one
confirmation mechanism (native elicitation, token dance, in-thread card) —
no new trust machinery.

## Risks and mitigations

- **Chat SDK is public beta; the vocabulary will drift.** Mitigation: a
  conformance test (devDep on `chat`, runtime dep still zero) that compiles
  representative IR through `toChatElement` and type-checks the result
  against the SDK's `ChatElement`, plus posts through a stub adapter. Drift
  breaks CI here, in one file — the same containment argument as `port.ts`.
- **Two vocabularies risk a second source of truth.** The IR is pinned as a
  *subset*: anything expressible in IR must compile losslessly to
  `ChatElement`; anything the SDK adds is adopted deliberately or stays
  reachable via the documented escape hatch (`thread.post` accepts raw SDK
  elements today and always will — the IR is additive, never a gate).
- **Platform capability variance** (Tables, modals, `ExternalSelect` differ
  per platform). Phase 2 scopes the IR to the intersection that Slack, Teams,
  and Google Chat all render (`card`, `text`, `fields`, `actions`, `button`,
  `select`, `image`, `divider`); `table` and `modal` join only with
  conformance coverage, and modals stay out of the IR entirely until a
  concrete consumer shows up (YAGNI — `event.openModal` with raw SDK elements
  is the escape hatch meanwhile).
- **Telegram's 64-byte `callback_data`** makes inline JSON values a footgun.
  The `@onAction` docs lead with the token-indirection path, not the inline
  one.

## Sequencing

Phases are independently shippable and strictly ordered by value:

1. **Phase 1 is nearly free** (port fields + docs + example) and closes the
   *perceived* gap — worth shipping immediately.
2. **Phase 2 is the differentiator** and the only net-new design surface;
   it needs the conformance-test harness set up first.
3. **Phase 3 waits for a real consumer** (the confirm bridge is the likely
   first: `hello-actors` or a triage example approving a state transition
   from Slack).

## Open questions

- Does `ChatThread` need `update(messageRef, content)` in the port (swap a
  card in place after an action, e.g. disable the clicked button)? The SDK's
  `SentMessage` return suggests edit support exists; verify and, if so, add
  in Phase 1 — in-place card updates are half the UX of approval flows.
- Should `toChatElement` live behind a subpath (`@agentback/chat/message`) to
  keep the barrel lean, mirroring `@agentback/files/fs`? Leaning barrel: the
  compiler is ~80 LoC with zero deps, and a subpath adds ceremony before
  there is anything heavy to isolate.
- Whether the `@tool`-returns-a-card recipe deserves a first-class marker
  (`chatUi:` on `@tool`, symmetric with `ui:` for MCP Apps) or stays a
  documented pattern. Default: pattern first, marker only if repetition
  proves it (copy-paste twice before abstracting).
- **Chat-platform miniapps (cross-repo, exploratory).** Several platforms can
  embed a full web surface behind a card button — Telegram Mini Apps, Discord
  Activities, Teams task modules — which would let a sealed single-file HTML
  miniapp (AgentGem's `game` Gem kind) ship *into* a chat thread with the IR
  card as its launcher, result, and approval surface; Slack and Google Chat
  have no such surface, so there the card is the entire projection. Two
  consequences to hold now, at zero cost: (1) the IR stays **data-shaped and
  platform-blind** — a `button` names an `actionId` and carries an opaque
  `value`, never assuming the consequence is server-side logic (it may be
  "open a webview"); the design already satisfies this, so it is a stated
  constraint, not a change. (2) If the extension becomes real, the serving +
  brokering half (HTTPS bundle route, capability-broker endpoint, platform
  identity → `principal`) lands on the AgentBack side of the seam — `rest` +
  `files` + this package's `installChat`/`@onAction` — and would be its own
  proposal, sequenced after the consent-UX question (who approves a
  capability: the publisher or each chat viewer?) has an answer.
