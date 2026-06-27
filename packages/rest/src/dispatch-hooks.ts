// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {
  REST_DISPATCH_HOOK_TAG,
  type RestDispatchHook,
  type RestDispatchInfo,
} from './keys.js';

/**
 * Resolve the dispatch hooks bound under {@link REST_DISPATCH_HOOK_TAG} on a
 * context, in bind order. Shared by both dispatch surfaces (Express
 * {@link RestServer.dispatch} and the Web `RestHandler`) so a hook is resolved
 * identically regardless of which runtime drives it.
 */
export async function resolveDispatchHooks(
  ctx: Context,
): Promise<RestDispatchHook[]> {
  const hooks: RestDispatchHook[] = [];
  for (const binding of ctx.findByTag(REST_DISPATCH_HOOK_TAG)) {
    hooks.push(await ctx.get<RestDispatchHook>(binding.key));
  }
  return hooks;
}

/**
 * Fold a resolved hook list into an onion around `run`, with `info` as the
 * shared per-request payload. The first-bound hook is the outermost wrapper
 * (it calls into the next, … into `run`). Shared by both dispatch surfaces so
 * the composition order is identical on Express and Web.
 */
export function applyDispatchHooks(
  hooks: RestDispatchHook[],
  info: RestDispatchInfo,
  run: () => Promise<unknown>,
): Promise<unknown> {
  let next = run;
  for (let i = hooks.length - 1; i >= 0; i--) {
    const hook = hooks[i]!;
    const inner = next;
    next = () => hook(info, inner);
  }
  return next();
}
