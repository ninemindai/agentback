// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  context as otelContext,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type {RequestHandler} from 'express';
import type {RestServer} from '@agentback/rest';
import {getTracer} from './tracer.js';

/** Options for {@link installOtel} / {@link mountOtel}. */
export interface OtelOptions {
  /**
   * Logical name stamped on every request span as `loopback.server.name` —
   * useful when one process runs several REST servers.
   */
  serverName?: string;
}

/**
 * Build the Express middleware that opens one `SERVER` span per request.
 *
 * - Span name: `<METHOD> <path>` (e.g. `GET /hello/world`).
 * - Attributes: `http.request.method`, `url.path`, and
 *   `http.response.status_code` once the response finishes.
 * - Extracts an incoming W3C `traceparent` via `propagation.extract`, so the
 *   request span joins the caller's distributed trace.
 * - Ends the span on response `finish` (or `close` for aborted requests);
 *   5xx responses get an `ERROR` span status.
 *
 * With no OTel SDK registered the `@opentelemetry/api` calls all no-op and
 * the middleware is a pass-through.
 */
export function createOtelMiddleware(
  options: OtelOptions = {},
): RequestHandler {
  return (req, res, next) => {
    const parentContext = propagation.extract(
      otelContext.active(),
      req.headers,
    );
    const span = getTracer().startSpan(
      `${req.method} ${req.path}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': req.method,
          'url.path': req.path,
          ...(options.serverName
            ? {'loopback.server.name': options.serverName}
            : {}),
        },
      },
      parentContext,
    );
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      span.setAttribute('http.response.status_code', res.statusCode);
      if (res.statusCode >= 500) {
        span.setStatus({code: SpanStatusCode.ERROR});
      }
      span.end();
    };
    res.on('finish', end);
    res.on('close', end);
    // Run the rest of the pipeline with the request span active so child
    // spans (dispatch, tools, outbound calls) parent under it when a real
    // context manager is installed.
    otelContext.with(trace.setSpan(parentContext, span), () => next());
  };
}

/**
 * Mount the per-request tracing middleware on a REST server's Express app.
 * Call BEFORE `app.start()` so it runs ahead of route handlers.
 */
export function mountOtel(server: RestServer, options: OtelOptions = {}): void {
  server.expressApp.use(createOtelMiddleware(options));
}
