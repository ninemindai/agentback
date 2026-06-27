// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export interface ClientErrorExtras {
  /**
   * Body parsed against the route's `responses[status]` schema, when one
   * is declared and parsing succeeds. Lets callers branch on a typed
   * error shape without re-parsing `body` themselves.
   */
  parsedBody?: unknown;
}

/**
 * Thrown when the server returns a non-2xx response, when input fails
 * client-side Zod validation, or when the response body fails the route's
 * `response:` schema. `status === 0` indicates a network-level failure
 * (fetch threw / aborted / timed out) or a client-side validation error
 * before the request went out.
 */
export class ClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly response?: Response;
  /**
   * Body parsed against the matching `responses[status]` schema, if one
   * was declared and parsing succeeded.
   */
  readonly parsedBody?: unknown;

  constructor(
    message: string,
    status: number,
    body: unknown,
    response?: Response,
    extras?: ClientErrorExtras,
  ) {
    super(message);
    this.name = 'ClientError';
    this.status = status;
    this.body = body;
    this.response = response;
    this.parsedBody = extras?.parsedBody;
  }
}
