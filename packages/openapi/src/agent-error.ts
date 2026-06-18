// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ParseIssue} from './zod-bridge.js';

/**
 * The machine-actionable error envelope shared by REST responses and MCP
 * tool errors. Agents consume the same contract on both surfaces:
 *
 * - `code` is a stable, machine-readable identifier (never parse `message`).
 * - `issues` carries per-field validation failures (path + expected/received).
 * - `schema` is the JSON Schema of the violated boundary section, so a caller
 *   can re-shape its input without a second round-trip to /openapi.json.
 * - `retryable` says whether retrying the SAME operation with corrected
 *   input/credentials can succeed.
 * - `hint` is a one-line remediation instruction written for an agent.
 */
export interface ErrorEnvelope {
  statusCode?: number;
  code: string;
  message: string;
  /**
   * Explicit safe client-visible text for rare intentional 5xx responses.
   * This input-only field is normalized into `message` and is not serialized
   * as its own envelope property by `buildErrorEnvelope`.
   */
  publicMessage?: string;
  /** Per-field validation issues (REST `details` carries the same array). */
  issues?: ParseIssue[];
  /** JSON Schema of the violated input section, when derivable. */
  schema?: unknown;
  /** Whether retrying with corrected input/credentials can succeed. */
  retryable?: boolean;
  /** One-line remediation instruction, written for an agent. */
  hint?: string;
  /** Confirmation token for `confirmation_required` errors (see `confirm:`). */
  confirmationToken?: string;
  /**
   * Payment challenge for `payment_required` errors — how to pay (x402
   * requirements, MPP session instructions, …). See
   * `@agentback/payments`.
   */
  challenge?: unknown;
}

/** Stable error codes emitted by the framework. Extensible by user code. */
export const ErrorCodes = {
  INVALID_BODY: 'invalid_body',
  INVALID_PARAMETER: 'invalid_parameter',
  INVALID_INPUT: 'invalid_input',
  INVALID_OUTPUT: 'invalid_output',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  CONFIRMATION_REQUIRED: 'confirmation_required',
  CONFIRMATION_INVALID: 'confirmation_invalid',
  PAYMENT_REQUIRED: 'payment_required',
  IDEMPOTENCY_KEY_REQUIRED: 'idempotency_key_required',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
} as const;

/** Options for constructing an {@link AgentError}. */
export interface AgentErrorOptions {
  /** Stable machine-readable code (see {@link ErrorCodes}). Defaults from status. */
  code?: string;
  /** HTTP-equivalent status. Default 400 (a client-correctable error). */
  status?: number;
  /** Per-field validation issues surfaced under `issues`. */
  issues?: ParseIssue[];
  /** One-line remediation hint for an agent. Defaults from `code`. */
  hint?: string;
  /** Override the default retryability derived from status/code. */
  retryable?: boolean;
  /** JSON Schema of the violated input section, when derivable. */
  schema?: unknown;
  /** Underlying cause, forwarded to `Error`'s `cause`. */
  cause?: unknown;
}

/**
 * A transport-neutral, client-correctable error for domain code.
 *
 * Throwing a plain `Error` from a service or `@tool` yields a redacted 500
 * (`code: internal_error`, `message: Internal Server Error`) on both REST and
 * MCP — so the reason never reaches the caller. `AgentError` carries the
 * `status`/`code`/`message` (and optional `issues`/`hint`/`schema`) that
 * {@link buildErrorEnvelope} reads, so the message survives on both surfaces.
 * Its message is always treated as public (even for intentional 5xx).
 *
 * ```ts
 * if (!city && lat == null)
 *   throw new AgentError('Provide either a city or both coordinates.', {
 *     code: ErrorCodes.INVALID_INPUT,
 *   });
 * ```
 *
 * For REST-specific validation failures the framework still ships
 * `invalidParameter` / `invalidRequestBody` (http-errors based); reach for
 * `AgentError` in domain/service code that is shared across transports.
 */
export class AgentError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Mirrors `message`; marks the text as safe to surface even for 5xx. */
  readonly publicMessage: string;
  readonly issues?: ParseIssue[];
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly schema?: unknown;

  constructor(message: string, options: AgentErrorOptions = {}) {
    super(
      message,
      options.cause !== undefined ? {cause: options.cause} : undefined,
    );
    this.name = 'AgentError';
    this.statusCode = options.status ?? 400;
    this.code = options.code ?? codeForStatus(this.statusCode);
    this.publicMessage = message;
    if (options.issues) this.issues = options.issues;
    if (options.hint !== undefined) this.hint = options.hint;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.schema !== undefined) this.schema = options.schema;
  }
}

/** Default code for a status when the thrown error carries none. */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return ErrorCodes.INVALID_PARAMETER;
    case 401:
      return ErrorCodes.UNAUTHORIZED;
    case 402:
      return ErrorCodes.PAYMENT_REQUIRED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return ErrorCodes.CONFLICT;
    case 422:
      return ErrorCodes.INVALID_BODY;
    case 429:
      return ErrorCodes.RATE_LIMITED;
    default:
      return status >= 500 ? ErrorCodes.INTERNAL_ERROR : 'error';
  }
}

/**
 * Whether retrying the same operation can succeed. Validation failures are
 * retryable (fix the input); auth failures are not (different credentials are
 * a different request); 429/503 are retryable after backoff.
 */
export function retryableForStatus(status: number, code?: string): boolean {
  if (
    code === ErrorCodes.CONFIRMATION_REQUIRED ||
    code === ErrorCodes.CONFIRMATION_INVALID ||
    code === ErrorCodes.IDEMPOTENCY_KEY_REQUIRED ||
    code === ErrorCodes.PAYMENT_REQUIRED ||
    code === ErrorCodes.INVALID_INPUT ||
    code === ErrorCodes.INVALID_BODY ||
    code === ErrorCodes.INVALID_PARAMETER
  ) {
    return true;
  }
  if (status === 400 || status === 422 || status === 429) return true;
  if (status === 503) return true;
  return false;
}

/** Default one-line remediation hint for the framework's own error codes. */
export function hintForCode(code: string): string | undefined {
  switch (code) {
    case ErrorCodes.INVALID_BODY:
    case ErrorCodes.INVALID_PARAMETER:
    case ErrorCodes.INVALID_INPUT:
      return (
        'Fix the listed issues (each has a path and expected type) and retry; ' +
        "the violated section's JSON Schema is included as 'schema'."
      );
    case ErrorCodes.UNAUTHORIZED:
      return (
        'Send valid credentials (see the securitySchemes in /openapi.json) ' +
        'and retry.'
      );
    case ErrorCodes.FORBIDDEN:
      return (
        'The authenticated principal lacks permission for this operation; ' +
        'retrying with the same credentials will not succeed.'
      );
    case ErrorCodes.CONFIRMATION_REQUIRED:
      return (
        'This operation requires confirmation. Retry the identical request ' +
        "with the issued token in the 'x-confirmation-token' header (REST) " +
        "or the 'confirmationToken' input property (MCP)."
      );
    case ErrorCodes.CONFIRMATION_INVALID:
      return (
        'The confirmation token is missing, expired, or was issued for a ' +
        'different request payload. Repeat the request without a token to ' +
        'obtain a fresh one, then retry with it.'
      );
    case ErrorCodes.IDEMPOTENCY_KEY_REQUIRED:
      return (
        "Send a unique 'idempotency-key' header; replaying the same key " +
        'returns the original result without re-executing the operation.'
      );
    case ErrorCodes.PAYMENT_REQUIRED:
      return (
        "Pay per the attached 'challenge' (x402: retry with the X-PAYMENT " +
        'header; MPP: open or top up a session), then retry the identical ' +
        'request.'
      );
    case ErrorCodes.RATE_LIMITED:
      return 'Back off and retry after the interval in the RateLimit headers.';
    default:
      return undefined;
  }
}

function publicMessageForError(
  statusCode: number,
  e: {message?: string; publicMessage?: string},
): string {
  if (statusCode >= 500) {
    return e.publicMessage ?? 'Internal Server Error';
  }
  return e.message ?? 'Internal Server Error';
}

/**
 * Assemble an {@link ErrorEnvelope} from a thrown error. Recognizes the
 * fields the framework's error constructors attach (`code`, `details`,
 * `issues`, `schema`, `hint`, `retryable`, `confirmationToken`) and fills
 * defaults from the status code for everything else.
 */
export function buildErrorEnvelope(
  err: unknown,
  fallbackStatus = 500,
): ErrorEnvelope {
  const e = err as Partial<ErrorEnvelope> & {
    status?: number;
    statusCode?: number;
    message?: string;
    publicMessage?: string;
    details?: ParseIssue[];
  };
  const statusCode = e.status ?? e.statusCode ?? fallbackStatus;
  const code = e.code ?? codeForStatus(statusCode);
  const issues = e.issues ?? e.details;
  return {
    statusCode,
    code,
    message: publicMessageForError(statusCode, e),
    ...(issues ? {issues} : {}),
    ...(e.schema !== undefined ? {schema: e.schema} : {}),
    retryable: e.retryable ?? retryableForStatus(statusCode, code),
    ...((e.hint ?? hintForCode(code)) !== undefined
      ? {hint: e.hint ?? hintForCode(code)}
      : {}),
    ...(e.confirmationToken ? {confirmationToken: e.confirmationToken} : {}),
    ...(e.challenge !== undefined ? {challenge: e.challenge} : {}),
  };
}
