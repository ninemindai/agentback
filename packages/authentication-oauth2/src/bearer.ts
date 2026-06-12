// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request} from 'express';
import createError from 'http-errors';

/**
 * Extract the bearer token from a request's `Authorization` header, throwing a
 * 401 when it is absent, not a `Bearer` scheme, or empty. Shared by the opaque
 * and JWT OAuth2 strategies so both reject malformed headers identically.
 */
export function extractBearerToken(request: Request): string {
  const header = request.headers.authorization;
  if (!header) {
    throw createError(401, 'Authorization header not found.');
  }
  if (!header.startsWith('Bearer ')) {
    throw createError(401, "Authorization header is not of type 'Bearer'.");
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw createError(
      401,
      "Authorization header value must be 'Bearer <token>'.",
    );
  }
  return token;
}
