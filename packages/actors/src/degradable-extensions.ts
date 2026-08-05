// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ContextView} from '@agentback/core';
import {loggers} from '@agentback/common';
import type {ZodType} from 'zod';

const log = loggers('agentback:actors:extensions');

/**
 * Generic host machinery for a seat-layer extension point: N providers,
 * composed by the host, each independently Zod-validated and independently
 * degradable. A broken provider never kills the host — the detector-registry
 * discipline (degrade-to-`[]`), made reusable across every extension point in
 * this package.
 *
 * Discovers every binding currently in `view` (typically injected via
 * `@extensions.view(extensionPointName)`, so the view is reactive to
 * plug/unplug) and Zod-validates the resolved value against `contract`.
 * A provider that fails resolution or contract validation is **excluded**
 * from the returned list and logged — it is rejected at registration, not
 * thrown, so a single broken provider never prevents the host from starting
 * or the other providers from being discovered.
 */
export async function collectValidatedExtensions<T>(
  view: ContextView<object>,
  extensionPointName: string,
  contract: ZodType<T>,
): Promise<T[]> {
  const providers: T[] = [];
  for (const binding of view.bindings) {
    let value: unknown;
    try {
      value = await view.context.get(binding.key);
    } catch (err) {
      log.error(
        "extension point '%s': provider bound at '%s' could not be resolved and was skipped: %s",
        extensionPointName,
        binding.key,
        err,
      );
      continue;
    }
    const parsed = contract.safeParse(value);
    if (!parsed.success) {
      log.error(
        "extension point '%s': provider bound at '%s' rejected at registration (failed contract validation) and was skipped: %s",
        extensionPointName,
        binding.key,
        parsed.error.message,
      );
      continue;
    }
    providers.push(parsed.data);
  }
  return providers;
}

/**
 * Runtime half of the same discipline: invoke `fn` for every already-
 * validated provider. A provider whose call throws (or rejects) is caught,
 * logged, and skipped — it degrades, it never kills the host and it never
 * blocks the remaining providers from running.
 */
export async function dispatchToExtensions<T extends {provider: string}>(
  providers: readonly T[],
  extensionPointName: string,
  fn: (provider: T) => void | Promise<void>,
): Promise<void> {
  for (const provider of providers) {
    try {
      await fn(provider);
    } catch (err) {
      log.error(
        "extension point '%s': provider '%s' threw at runtime and was skipped: %s",
        extensionPointName,
        provider.provider,
        err,
      );
    }
  }
}
