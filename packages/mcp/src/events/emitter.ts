// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  AuthorizationDecision,
  buildAuthorizationContext,
  getAuthorizationMetadata,
  runAuthorization,
} from '@agentback/authorization';
import {loggers} from '@agentback/common';
import {
  BindingScope,
  Context,
  inject,
  injectable,
  resolveInjectedArguments,
} from '@agentback/context';
import {extensionFilter} from '@agentback/core';
import {ErrorCodes, standardParse} from '@agentback/openapi';
import {SecurityBindings} from '@agentback/security';
import {MCP_SERVERS, MCPBindings} from '../keys.js';
import {
  MAX_EVENT_BYTES,
  type EmitOptions,
  type EmitReport,
  type EventOccurrence,
  type EventSubscription,
  type McpEventEmitter,
} from './ports.js';
import {servedEvents, type EventBinding} from './registry.js';
import {subscriberProfile} from './subscriptions.js';

/** Subscriptions processed concurrently per emit. */
const FANOUT_CONCURRENCY = 32;

/** An emit-time payload error, shaped like an invalid tool output. */
function invalidPayload(message: string, issues?: unknown): Error {
  const err = new Error(message) as Error & {code: string; issues?: unknown};
  err.code = ErrorCodes.INVALID_OUTPUT;
  if (issues !== undefined) err.issues = issues;
  return err;
}

const log = loggers('agentback:mcp:events');

/**
 * The default {@link McpEventEmitter}, bound app-level at
 * `MCPBindings.EVENTS` by `MCPComponent`.
 *
 * Per emit: validate `data` against the event's `payload` schema (by
 * construction, every delivered `data` matches `payloadSchema`), then for
 * each live subscription — re-check access (revocation), run `match`, and
 * hand the occurrence to `MCPBindings.EVENT_DELIVERY`. One subscription's
 * failure never stops the fan-out to the others.
 *
 * Discovery runs against the app context, so an `@event` must be bound at
 * the app level (`app.service(...)`) to be emittable; a per-session binder's
 * event types are listed to that session but cannot be emitted.
 */
@injectable({scope: BindingScope.SINGLETON})
export class DefaultMcpEventEmitter implements McpEventEmitter {
  /** Event methods already warned about returning a non-boolean. */
  private readonly warnedNonBoolean = new Set<string>();

  constructor(@inject.context() private readonly ctx: Context) {}

  async emit(
    name: string,
    data: unknown,
    opts: EmitOptions = {},
  ): Promise<EmitReport> {
    const served = servedEvents(this.ctx);
    const event = served.find(e => e.meta.name === name);
    if (!event) {
      throw new Error(
        `Unknown MCP event '${name}'. Emittable events: ${
          served.map(e => e.meta.name).join(', ') || '(none)'
        }. An @event must be on an @mcpServer class bound at the app level ` +
          `(app.service(...)); an event a perSession binder contributes is ` +
          `listed to that session but cannot be emitted.`,
      );
    }
    if (
      opts.eventId !== undefined &&
      !/^[\x21-\x7e]{1,255}$/.test(opts.eventId)
    ) {
      throw new Error(
        `Invalid eventId for event ${name}: 1-255 visible ASCII characters ` +
          `(it is sent as the webhook-id header)`,
      );
    }

    const parsed = standardParse(event.meta.payload, data);
    if (!parsed.success) {
      const first = parsed.issues[0];
      const where = first?.path?.length ? first.path.join('.') : 'data';
      throw invalidPayload(
        `Invalid payload for event ${name}: ${where}: ${
          first?.message ?? 'invalid'
        }`,
        parsed.issues,
      );
    }
    // A frozen copy: one subscription's `match` cannot alter what the next
    // sees, and a vendor that validates in place never freezes the caller's
    // own object.
    const payload = deepFreeze(
      structuredClone(parsed.data) as Record<string, unknown>,
    );
    const occurrence: EventOccurrence = {
      eventId: opts.eventId ?? `evt_${crypto.randomUUID()}`,
      name,
      timestamp: toIso(opts.timestamp),
      data: payload,
      cursor: null,
    };
    // Refused here, like a schema mismatch, rather than dropped later: a
    // receiver may answer 413, and a 413 is never retried.
    const bytes = new TextEncoder().encode(
      JSON.stringify(occurrence),
    ).byteLength;
    if (bytes > MAX_EVENT_BYTES) {
      throw invalidPayload(
        `Invalid payload for event ${name}: the occurrence is ${bytes} bytes, ` +
          `over the ${MAX_EVENT_BYTES}-byte delivery limit. Send a summary ` +
          `plus the id a read tool takes.`,
      );
    }

    const store = await this.ctx.get(MCPBindings.SUBSCRIPTION_STORE);
    const subs = await store.listByEvent(name);
    const report: EmitReport = {
      eventId: occurrence.eventId,
      subscriptions: subs.length,
      queued: 0,
      revoked: 0,
    };
    if (subs.length === 0) return report;

    const delivery = await this.ctx.get(MCPBindings.EVENT_DELIVERY, {
      optional: true,
    });
    const accessCheck = await this.ctx.get(MCPBindings.EVENT_ACCESS_CHECK, {
      optional: true,
    });
    // Resolved once per emit; a class retracted since discovery matches none.
    const key = this.ctx
      .find(extensionFilter(MCP_SERVERS))
      .find(b => b.valueConstructor === event.ctor)?.key;
    if (key === undefined) return report;

    const one = async (sub: EventSubscription) => {
      try {
        if (!(await this.stillPermitted(event, sub, accessCheck))) {
          await store.delete(sub.id);
          report.revoked++;
          log.info(
            'revoked subscription %s to %s: access check failed',
            sub.id,
            name,
          );
          return;
        }
        if (!(await this.matches(event, key, sub, payload))) return;
        if (!delivery) {
          log.warn(
            'no MCPBindings.EVENT_DELIVERY bound; dropping %s for %s',
            occurrence.eventId,
            sub.id,
          );
          return;
        }
        await delivery.deliver(sub, occurrence);
        report.queued++;
      } catch (err) {
        log.error(
          'event %s: subscription %s failed: %s',
          name,
          sub.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    };
    // Bounded fan-out: a popular event must not open thousands of concurrent
    // voter runs and enqueues at once.
    for (let i = 0; i < subs.length; i += FANOUT_CONCURRENCY) {
      await Promise.all(subs.slice(i, i + FANOUT_CONCURRENCY).map(one));
    }
    return report;
  }

  /**
   * Revocation, checked before every delivery: the event method's
   * `@authorize` voters re-run against the subscriber's profile (a voter can
   * consult live state), then the optional `EVENT_ACCESS_CHECK` hook.
   */
  private async stillPermitted(
    event: EventBinding,
    sub: EventSubscription,
    accessCheck:
      ((s: EventSubscription) => boolean | Promise<boolean>) | undefined,
  ): Promise<boolean> {
    const methodName = event.meta.methodName as string;
    const meta = getAuthorizationMetadata(event.ctor, methodName);
    if (meta && !meta.skip) {
      const authCtx = buildAuthorizationContext(
        subscriberProfile(sub),
        `${event.ctor.name}.${methodName}`,
      );
      const decision = await runAuthorization(
        authCtx,
        meta,
        new Context(this.ctx, 'mcp.event'),
      );
      if (decision !== AuthorizationDecision.ALLOW) return false;
    }
    return accessCheck ? (await accessCheck(sub)) === true : true;
  }

  /** Run the event's `match(args, data)` for one subscription. */
  private async matches(
    event: EventBinding,
    key: string,
    sub: EventSubscription,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    let args: unknown = sub.arguments;
    if (event.meta.input) {
      const parsedArgs = standardParse(event.meta.input, sub.arguments);
      // Arguments that validated at subscribe time but no longer do (the
      // input schema was tightened in place) cannot be matched safely.
      if (!parsedArgs.success) {
        log.warn(
          'subscription %s arguments no longer satisfy %s input; skipping',
          sub.id,
          event.meta.name,
        );
        return false;
      }
      args = parsedArgs.data;
    }
    const reqCtx = new Context(this.ctx, 'mcp.event');
    reqCtx.bind(SecurityBindings.USER).to(subscriberProfile(sub));
    const methodName = event.meta.methodName as string;
    const callArgs = await resolveInjectedArguments(
      event.ctor.prototype,
      methodName,
      reqCtx,
      undefined,
      [args, payload],
    );
    const instance = await reqCtx.get<Record<string, Function>>(key);
    const result = await instance[methodName]!.apply(instance, callArgs);
    if (typeof result !== 'boolean' && !this.warnedNonBoolean.has(methodName)) {
      this.warnedNonBoolean.add(methodName);
      log.warn(
        "@event('%s') %s.%s returned %s, not a boolean — treated as no match",
        event.meta.name,
        event.ctor.name,
        methodName,
        typeof result,
      );
    }
    return result === true;
  }
}

function toIso(ts: Date | string | undefined): string {
  if (ts === undefined) return new Date().toISOString();
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid event timestamp: ${String(ts)}`);
  }
  return d.toISOString();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
