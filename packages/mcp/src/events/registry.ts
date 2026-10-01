// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {extensionFilter} from '@agentback/core';
import {MetadataInspector} from '@agentback/metadata';
import {schemaToOpenApiSchema} from '@agentback/openapi';
import {MCP_SERVERS, MCPKeys, type EventMetadata} from '../keys.js';
import {requiredScopesForTool} from '../policy.js';

/** One discovered `@event` method. */
export interface EventBinding {
  ctor: Function;
  meta: EventMetadata;
}

/** One event type's `events/list` entry, as published to clients. */
export interface EventListEntry {
  name: string;
  title?: string;
  description?: string;
  /** The delivery modes offered. Webhook is the only one built. */
  delivery: ['webhook'];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

interface CompiledEvent {
  entry: EventListEntry;
  requiredScopes: string[];
}

/**
 * Compiled-event cache keyed `ctor -> methodName`, for the reasons
 * `compiledTools` in `mcp.server.ts` gives: the class and method name are the
 * stable identity, and a stateless server is built per request, so an
 * instance cache would miss exactly when it matters.
 */
const compiledEvents = new WeakMap<Function, Map<string, CompiledEvent>>();

/**
 * Every `@event` method across the `@mcpServer` contributors visible from
 * `ctx`, root-nearest first: an event bound on the app context precedes one
 * bound in a per-session/per-request child, so a child cannot shadow an app
 * event of the same name.
 */
export function collectEvents(ctx: Context): EventBinding[] {
  const out: {e: EventBinding; d: number; i: number}[] = [];
  const seen = new Set<Function>();
  for (const b of ctx.find(extensionFilter(MCP_SERVERS))) {
    const ctor = b.valueConstructor;
    if (typeof ctor !== 'function' || seen.has(ctor)) continue;
    seen.add(ctor);
    const members =
      MetadataInspector.getAllMethodMetadata<EventMetadata>(
        MCPKeys.EVENT,
        ctor.prototype,
      ) ?? {};
    const depth = contextDepth(ctx.getOwnerContext(b.key));
    for (const [methodName, meta] of Object.entries(members)) {
      if (!meta) continue;
      out.push({
        e: {ctor, meta: {...meta, methodName}},
        d: depth,
        i: out.length,
      });
    }
  }
  return out.sort((a, b) => a.d - b.d || a.i - b.i).map(x => x.e);
}

/** One event per name, root-nearest winning. */
export function servedEvents(ctx: Context): EventBinding[] {
  const winners = new Map<string, EventBinding>();
  for (const e of collectEvents(ctx)) {
    if (!winners.has(e.meta.name)) winners.set(e.meta.name, e);
  }
  return [...winners.values()];
}

/**
 * Throw when two distinct methods declare the same event name. Checked at
 * `start()`, like duplicate tool names; a later collision is served
 * root-nearest first by {@link servedEvents}.
 */
export function assertUniqueEventNames(ctx: Context): void {
  const seen = new Map<string, EventBinding>();
  for (const e of collectEvents(ctx)) {
    const prior = seen.get(e.meta.name);
    if (
      prior &&
      !(prior.ctor === e.ctor && prior.meta.methodName === e.meta.methodName)
    ) {
      const where = (x: EventBinding) =>
        `${x.ctor.name}.${String(x.meta.methodName)}`;
      throw new Error(
        `Duplicate MCP event name '${e.meta.name}': ${where(prior)} and ` +
          `${where(e)}. Rename one.`,
      );
    }
    seen.set(e.meta.name, e);
  }
}

/**
 * The caller-invariant half of an event type: its published entry (JSON
 * Schema emitted eagerly, so a schema that cannot describe itself fails at
 * `start()`/`buildServer()`, not at a client's first `events/list`) and the
 * scopes that gate it.
 */
export function compileEvent(e: EventBinding): CompiledEvent {
  const methodName = e.meta.methodName as string;
  let perClass = compiledEvents.get(e.ctor);
  const hit = perClass?.get(methodName);
  if (hit) return hit;

  const inputSchema = e.meta.input
    ? objectSchema(e.meta.name, 'input', e.meta.input)
    : {type: 'object'};
  const payloadSchema = objectSchema(e.meta.name, 'payload', e.meta.payload);
  const compiled: CompiledEvent = {
    entry: {
      name: e.meta.name,
      ...(e.meta.title !== undefined ? {title: e.meta.title} : {}),
      ...(e.meta.description !== undefined
        ? {description: e.meta.description}
        : {}),
      delivery: ['webhook'],
      inputSchema,
      payloadSchema,
    },
    requiredScopes: requiredScopesForTool(e.ctor, e.meta),
  };
  if (!perClass) {
    perClass = new Map();
    compiledEvents.set(e.ctor, perClass);
  }
  perClass.set(methodName, compiled);
  return compiled;
}

/**
 * The events visible to one caller: the served set minus those whose
 * required scopes `scopes` does not cover. `scopes === undefined` means an
 * unauthenticated transport with nothing to filter on (stdio); an
 * authenticated transport passes `[]` for an anonymous caller, never
 * `undefined` — the stateless invariant tools already depend on.
 */
export function visibleEvents(
  ctx: Context,
  scopes?: string[],
): Map<string, {event: EventBinding; entry: EventListEntry}> {
  const out = new Map<string, {event: EventBinding; entry: EventListEntry}>();
  for (const e of servedEvents(ctx)) {
    const {entry, requiredScopes} = compileEvent(e);
    if (
      scopes &&
      requiredScopes.length &&
      !requiredScopes.every(s => scopes.includes(s))
    ) {
      continue;
    }
    out.set(e.meta.name, {event: e, entry});
  }
  return out;
}

function objectSchema(
  name: string,
  slot: 'input' | 'payload',
  schema: NonNullable<EventMetadata['input']>,
): Record<string, unknown> {
  const json = schemaToOpenApiSchema(schema) as Record<string, unknown>;
  if (json.type !== 'object') {
    throw new Error(
      `MCP event '${name}': ${slot} schema must be an object ` +
        `(z.object(...)) — ${
          slot === 'input'
            ? 'subscription arguments are named properties'
            : 'an occurrence’s data is a JSON object'
        } — but it lowered to ${
          typeof json.type === 'string'
            ? `a non-object \`${json.type}\``
            : 'a non-object schema'
        }.`,
    );
  }
  return json;
}

function contextDepth(ctx: Context | undefined): number {
  let depth = 0;
  for (let c = ctx?.parent; c; c = c.parent) depth++;
  return depth;
}
