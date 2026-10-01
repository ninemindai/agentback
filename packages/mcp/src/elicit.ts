// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  createRequestStateCodec,
  inputResponse,
  type RequestStateCodec,
} from '@modelcontextprotocol/server';
import {
  AgentError,
  ErrorCodes,
  schemaToOpenApiSchema,
  standardParse,
  type InferSchema,
  type SchemaLike,
} from '@agentback/openapi';

/** The `inputRequests` key `confirm:` uses; reserved for every tool. */
export const CONFIRM_REQUEST_KEY = 'confirm';

/** The client extension id that unlocks an elicitation's `extended` form. */
export const OPENAI_ELICITATION_EXTENSION = 'openai/elicitation';

// ---- the caller ------------------------------------------------------------

/**
 * What the server knows about the client behind the current request. Bound
 * per request as `MCPBindings.REQUEST_CLIENT` by the SDK `tools/call` handler;
 * absent on an in-process `callTool`.
 */
export interface RequestClient {
  /** `modern` for the 2026-07-28 revision, `legacy` for the 2025 era. */
  era: 'modern' | 'legacy';
  /**
   * The client's declared capabilities: from the 2026 per-request envelope, or
   * from `initialize` on a 2025 connection. `undefined` means **unknown**, not
   * "none" — a stateless 2025 request never carried them.
   */
  capabilities?: Record<string, unknown>;
  /** The client's `clientInfo`, when the transport saw one. */
  info?: {name?: string; version?: string; [k: string]: unknown};
  /**
   * Whether a server→client round trip can happen on this request: true for
   * the 2026 era, 2025 sessions and stdio; false for a stateless 2025 request,
   * which has no connection to send a request on.
   */
  canRoundTrip: boolean;
}

/**
 * Whether the client declared extension `id`, in `extensions` (the 2026 shape)
 * or `experimental` (where 2025-era hosts put it). A hint for choosing a
 * presentation, never a permission.
 */
export function hasClientExtension(
  client: RequestClient | undefined,
  id: string,
): boolean {
  const caps = client?.capabilities;
  if (!caps) return false;
  const pick = (k: string) =>
    (caps[k] as Record<string, unknown> | undefined)?.[id] !== undefined;
  return pick('extensions') || pick('experimental');
}

// ---- forms and the elicitor ------------------------------------------------

/**
 * One question for the user.
 *
 * - `standard` is a **flat** Zod object (string, number, integer, boolean or
 *   enum fields): the restricted form every client that can elicit renders.
 * - `extended` is an optional raw JSON Schema sent instead to clients that
 *   declare `openai/elicitation`. It must produce an answer `standard`
 *   accepts — the answer is validated against `standard` either way — and TS
 *   SDK clients drop vendor keys on individual properties (top-level extras
 *   survive), so design it to degrade.
 */
export interface ElicitForm<S extends SchemaLike = SchemaLike> {
  /** What the host shows above the form. */
  message: string;
  standard?: S;
  extended?: Record<string, unknown>;
}

/** The validated answer to an {@link ElicitForm}. */
export type ElicitAnswer<F> =
  F extends ElicitForm<infer S>
    ? S extends SchemaLike
      ? InferSchema<S>
      : unknown
    : unknown;

/**
 * Ask the user something mid-call. Inject with
 * `@inject(MCPBindings.ELICIT) elicit: Elicitor` at slot 1+.
 *
 * The tool body **re-runs from the top** each round, on every era: an `ask`
 * whose answer is not here yet suspends the call, and the next round replays
 * earlier answers. So ask **before** any side effect.
 *
 * @experimental Phase 2 of docs/proposals/host-extensions.md.
 */
export interface Elicitor {
  /**
   * The answer to `key`, or suspend the call to ask for it. A declined or
   * cancelled answer throws `AgentError` `elicitation_declined`.
   */
  ask<F extends ElicitForm>(key: string, form: F): Promise<ElicitAnswer<F>>;
  /** Several questions in one round; suspends once for every missing answer. */
  askAll<M extends Record<string, ElicitForm>>(
    forms: M,
  ): Promise<{[K in keyof M]: ElicitAnswer<M[K]>}>;
}

const INPUT_REQUIRED = Symbol.for('agentback.mcp.inputRequired');

/**
 * Thrown by {@link Elicitor.ask} to suspend a call. Rethrow it: a tool that
 * catches errors must let this one through (`if (isInputRequired(e)) throw e`).
 */
export class InputRequiredSignal extends Error {
  readonly [INPUT_REQUIRED] = true;
  constructor(readonly keys: string[]) {
    super(
      `MCP elicitation pending for ${keys.map(k => `'${k}'`).join(', ')} — ` +
        `this signal suspends the call and must not be caught.`,
    );
    this.name = 'InputRequiredSignal';
  }
}

/**
 * A programming error in how a tool uses elicitation (asking after streaming,
 * a reserved or duplicate key, a non-flat form). Never swallowed into the
 * "tool swallowed the signal" diagnosis: it names the real mistake.
 */
export class ElicitMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElicitMisuseError';
  }
}

/** True for the signal {@link Elicitor.ask} throws to suspend a call. */
export function isInputRequired(err: unknown): err is InputRequiredSignal {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as {[INPUT_REQUIRED]?: unknown})[INPUT_REQUIRED] === true
  );
}

/** A question waiting for the user, recorded by an ask that suspended. */
export interface PendingAsk {
  form: ElicitForm;
}

/**
 * The per-request elicitor and its bookkeeping. The dispatcher reads
 * `pending` and `answers` after the tool body suspends.
 */
export interface ElicitSession extends Elicitor {
  readonly pending: Map<string, PendingAsk>;
  /** Every answer known this round: replayed ones plus newly accepted ones. */
  readonly answers: Record<string, unknown>;
}

/** Throw unless `form.standard` lowers to a flat object of primitives. */
export function assertFlatForm(key: string, form: ElicitForm): void {
  if (!form.standard) {
    if (!form.extended) {
      throw new ElicitMisuseError(
        `elicit.ask('${key}'): a form needs a standard schema, an extended ` +
          `schema, or both`,
      );
    }
    return;
  }
  const json = schemaToOpenApiSchema(form.standard) as {
    type?: unknown;
    properties?: Record<string, {type?: unknown; items?: {enum?: unknown}}>;
  };
  if (json.type !== 'object' || !json.properties) {
    throw new ElicitMisuseError(
      `elicit.ask('${key}'): standard must be a z.object(...) — elicitation ` +
        `forms are a flat object of fields`,
    );
  }
  for (const [name, prop] of Object.entries(json.properties)) {
    const t = prop.type;
    const primitive =
      t === 'string' || t === 'number' || t === 'integer' || t === 'boolean';
    const enumArray = t === 'array' && Array.isArray(prop.items?.enum);
    if (!primitive && !enumArray) {
      throw new ElicitMisuseError(
        `elicit.ask('${key}'): field '${name}' is not a primitive — ` +
          `elicitation forms allow string, number, integer, boolean and enum ` +
          `fields only`,
      );
    }
  }
}

/**
 * Build the per-request elicitor. `replayed` holds answers sealed into an
 * earlier round's request state; `responses` is this round's `inputResponses`.
 */
export function createElicitSession(
  replayed: Record<string, unknown>,
  responses: Record<string, unknown> | undefined,
): ElicitSession {
  const pending = new Map<string, PendingAsk>();
  const answers: Record<string, unknown> = {...replayed};
  const asked = new Set<string>();

  /** The answer for `key`, or `undefined` to record it as pending. */
  function resolve(key: string, form: ElicitForm): unknown {
    if (key === CONFIRM_REQUEST_KEY) {
      throw new ElicitMisuseError(
        `elicit.ask('${key}'): the '${CONFIRM_REQUEST_KEY}' key is reserved ` +
          `for confirm: tools — pick another key`,
      );
    }
    if (asked.has(key)) {
      throw new ElicitMisuseError(
        `elicit.ask('${key}'): asked twice in one call — use a distinct key ` +
          `per question`,
      );
    }
    asked.add(key);
    assertFlatForm(key, form);
    if (key in answers) return answers[key];

    const answer = inputResponse(responses ?? {}, key);
    if (answer.kind !== 'elicit') {
      pending.set(key, {form});
      return undefined;
    }
    if (answer.action !== 'accept') {
      throw new AgentError(
        `The user ${answer.action === 'cancel' ? 'cancelled' : 'declined'} ` +
          `the '${key}' question, so the tool did not finish.`,
        {code: ErrorCodes.ELICITATION_DECLINED, status: 409, retryable: false},
      );
    }
    let content: unknown = answer.content ?? {};
    if (form.standard) {
      const parsed = standardParse(form.standard, content);
      if (!parsed.success) {
        throw new AgentError(
          `The answer to the '${key}' question failed validation.`,
          {code: ErrorCodes.INVALID_INPUT, issues: parsed.issues},
        );
      }
      content = parsed.data;
    }
    answers[key] = content;
    return content;
  }

  return {
    pending,
    answers,
    async ask<F extends ElicitForm>(key: string, form: F) {
      const value = resolve(key, form);
      if (pending.size) throw new InputRequiredSignal([...pending.keys()]);
      return value as ElicitAnswer<F>;
    },
    async askAll<M extends Record<string, ElicitForm>>(forms: M) {
      const out: Record<string, unknown> = {};
      for (const [key, form] of Object.entries(forms)) {
        out[key] = resolve(key, form);
      }
      if (pending.size) throw new InputRequiredSignal([...pending.keys()]);
      return out as {[K in keyof M]: ElicitAnswer<M[K]>};
    },
  };
}

/**
 * The app-level default for `MCPBindings.ELICIT`, so injection never fails
 * outside an MCP request (an in-process `callTool`, a unit test): any ask
 * throws `elicitation_unavailable`.
 */
export const unavailableElicitor: Elicitor = {
  async ask(key) {
    throw elicitationUnavailable(`elicit.ask('${key}')`);
  },
  async askAll(forms) {
    throw elicitationUnavailable(
      `elicit.askAll(${Object.keys(forms)
        .map(k => `'${k}'`)
        .join(', ')})`,
    );
  },
};

/** Why a caller cannot be asked. */
export type UnavailableCause =
  'in-process' | 'stateless' | 'no-capability' | 'no-request';

const UNAVAILABLE_REASONS: Record<UnavailableCause, string> = {
  'in-process':
    'it was called in-process (callTool, an agent turn or the CLI), which ' +
    'has no user to ask. Call it through an MCP client instead.',
  stateless:
    'this is a stateless 2025-era request, which cannot carry a ' +
    "server-to-client request. The default installMcpHttp mount ('both') " +
    "serves 2025 clients statelessly: use protocol: 'legacy', stdio, or a " +
    '2026-07-28 client.',
  'no-capability': 'the client did not declare the elicitation capability.',
  'no-request':
    'there is no MCP request here. Inject MCPBindings.ELICIT as a @tool ' +
    "method parameter, not into a constructor or a service: the tool's own " +
    'request binds the real elicitor.',
};

/** `AgentError` for a caller that cannot answer an elicitation. */
export function elicitationUnavailable(
  what: string,
  cause: UnavailableCause = 'no-request',
): AgentError {
  return new AgentError(
    `${what} needs the user, but this caller cannot be asked: ` +
      UNAVAILABLE_REASONS[cause],
    {code: ErrorCodes.ELICITATION_UNAVAILABLE, status: 422, retryable: false},
  );
}

// ---- request state ---------------------------------------------------------

/**
 * The one framework-owned `requestState` payload, shared by `confirm:` and
 * elicitation so a single verify covers both. Signed (HMAC), not encrypted:
 * nothing secret goes in it.
 *
 * - `tool`, `fp` (input fingerprint) and `sub` (the caller) bind it to one
 *   call, so state minted for one tool, input or caller is refused for
 *   another.
 * - `confirm` is a `ConfirmationStore` token awaiting a human answer.
 * - `confirmed` is a fresh store token issued after an accepted confirmation,
 *   carried while the tool's own questions are pending. The store stays the
 *   single-use authority: a replayed envelope fails `store.verify`.
 * - `answers` are earlier rounds' validated answers. A retry carries only the
 *   latest round's `inputResponses`, so without these a second `ask` would
 *   lose the first answer and loop.
 */
export interface RequestStatePayload {
  v: 1;
  tool: string;
  fp: string;
  /** The caller it was minted for (transport client or principal). */
  sub?: string;
  confirm?: string;
  confirmed?: string;
  answers?: Record<string, unknown>;
}

const codecs = new Map<string, RequestStateCodec<RequestStatePayload>>();

/** The codec for `key` (at least 32 bytes), memoized per key and TTL. */
export function requestStateCodec(
  key: string | Uint8Array,
  ttlSeconds = 3600,
): RequestStateCodec<RequestStatePayload> {
  const id =
    (typeof key === 'string' ? `s:${key}` : `b:${[...key].join(',')}`) +
    `#${ttlSeconds}`;
  let codec = codecs.get(id);
  if (!codec) {
    codec = createRequestStateCodec<RequestStatePayload>({key, ttlSeconds});
    codecs.set(id, codec);
  }
  return codec;
}

/** A random per-process request-state key (hex, 32 bytes of entropy). */
export function randomRequestStateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Lower a form to the `requestedSchema` the client renders. */
export function requestedSchemaFor(
  key: string,
  form: ElicitForm,
  client: RequestClient | undefined,
): Record<string, unknown> {
  // Modern era only. On a 2025 connection OpenAI's extended forms travel on
  // their own method (`openai/elicitation/create`), not the standard
  // `elicitation/create` the SDK shim sends — so a legacy client gets the
  // standard form even when it declared the extension.
  if (
    form.extended &&
    client?.era === 'modern' &&
    hasClientExtension(client, OPENAI_ELICITATION_EXTENSION)
  ) {
    return form.extended;
  }
  if (form.standard) {
    return schemaToOpenApiSchema(form.standard) as Record<string, unknown>;
  }
  throw new AgentError(
    `The '${key}' question has only an extended form, and this client did ` +
      `not declare '${OPENAI_ELICITATION_EXTENSION}'.`,
    {code: ErrorCodes.ELICITATION_UNSUPPORTED, status: 422, retryable: false},
  );
}
