// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Navigation-focus context bus.
 *
 * Explorer panels call `publishFocus` when the user selects an entity; the
 * agent dock subscribes to attach "what the developer is looking at" as
 * ambient context to the next message.
 *
 * The descriptor shape mirrors `@agentback/introspection`'s `get` selector
 * so the dock can pass it through unchanged.
 *
 * Framework-agnostic: no React, no external deps — a plain module-level
 * pub/sub backed by a `Set` of listeners.
 */

export type FocusKind = 'schema-entity' | 'binding' | 'route' | 'tool';

/** Identifies the entity the developer is currently inspecting. */
export interface FocusDescriptor {
  kind: FocusKind;
  /** Stable entity id (binding key, schema id, route ref, tool name). */
  id: string;
  /** Human-readable display name; optional. */
  label?: string;
}

export type FocusListener = (descriptor: FocusDescriptor | null) => void;

// Module-level state — one bus per JS realm (i.e. the SPA bundle).
let _current: FocusDescriptor | null = null;
const _listeners: Set<FocusListener> = new Set();

/**
 * Publish a new focus descriptor (or `null` to clear).
 * All current subscribers are notified synchronously.
 */
export function publishFocus(descriptor: FocusDescriptor | null): void {
  _current = descriptor;
  for (const fn of _listeners) {
    fn(descriptor);
  }
}

/**
 * Subscribe to focus changes. Returns an unsubscribe fn.
 * Does NOT fire immediately on subscribe — call getFocus() on mount for the
 * current value, then subscribeFocus for updates.
 */
export function subscribeFocus(fn: FocusListener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Return the current focus descriptor (or `null` if none). */
export function getFocus(): FocusDescriptor | null {
  return _current;
}
