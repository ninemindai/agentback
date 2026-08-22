// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Binding,
  Context,
  ContextView,
  inject,
  invokeMethod,
  sortBindingsByPhase,
} from '@agentback/context';
import {loggers} from '@agentback/common';
import {CoreBindings, CoreTags} from './keys.js';
import {LifeCycleObserver, lifeCycleObserverFilter} from './lifecycle.js';
const log = loggers('loopback:core:lifecycle');

/**
 * A group of life cycle observers
 */
export type LifeCycleObserverGroup = {
  /**
   * Observer group name
   */
  group: string;
  /**
   * Bindings for observers within the group
   */
  bindings: Readonly<Binding<LifeCycleObserver>>[];
};

export type LifeCycleObserverOptions = {
  /**
   * Control the order of observer groups for notifications. For example,
   * with `['datasource', 'server']`, the observers in `datasource` group are
   * notified before those in `server` group during `start`. Please note that
   * observers are notified in the reverse order during `stop`.
   */
  orderedGroups: string[];
  /**
   * Override and disable lifecycle observer groups. This setting applies to
   * both ordered groups (i.e. those defined in `orderedGroups`) and unordered
   * groups.
   */
  disabledGroups?: string[];
  /**
   * Notify observers of the same group in parallel, default to `true`
   */
  parallel?: boolean;
};

export const DEFAULT_ORDERED_GROUPS = ['server'];

/**
 * Per-call knobs for a notification pass. Both exist for
 * {@link LifeCycleObserverRegistry.startObservers}'s rollback; the full
 * `init`/`start`/`stop` passes pass neither and are unchanged.
 */
interface NotifyOptions {
  /** Called with a binding key AFTER that observer's handler resolved. */
  onNotified?: (key: string) => void;
  /** Await every parallel notification's settlement before throwing. */
  settle?: boolean;
  /**
   * Resolve only the bindings in the given groups instead of the whole
   * observer view. Set by the partial (`init`/`start`/`stop` subset) paths.
   */
  partial?: boolean;
}

/**
 * A context-based registry for life cycle observers
 */
export class LifeCycleObserverRegistry implements LifeCycleObserver {
  constructor(
    @inject.context()
    protected readonly context: Context,
    @inject.view(lifeCycleObserverFilter)
    protected readonly observersView: ContextView<LifeCycleObserver>,
    @inject(CoreBindings.LIFE_CYCLE_OBSERVER_OPTIONS, {optional: true})
    protected readonly options: LifeCycleObserverOptions = {
      parallel: true,
      orderedGroups: DEFAULT_ORDERED_GROUPS,
    },
  ) {}

  setOrderedGroups(groups: string[]) {
    this.options.orderedGroups = groups;
  }

  /**
   * Get observer groups ordered by the group
   */
  public getObserverGroupsByOrder(): LifeCycleObserverGroup[] {
    const bindings = this.observersView.bindings;
    const groups = this.sortObserverBindingsByGroup(bindings);
    if (log.debug.enabled) {
      log.debug(
        'Observer groups: %j',
        groups.map(g => ({
          group: g.group,
          bindings: g.bindings.map(b => b.key),
        })),
      );
    }
    return groups;
  }

  /**
   * Get the group for a given life cycle observer binding
   * @param binding - Life cycle observer binding
   */
  protected getObserverGroup(
    binding: Readonly<Binding<LifeCycleObserver>>,
  ): string {
    // First check if there is an explicit group name in the tag
    let group = binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP];
    if (!group) {
      // Fall back to a tag that matches one of the groups
      group = this.options.orderedGroups.find(g => binding.tagMap[g] === g);
    }
    group = group || '';
    log.debug(
      'Binding %s is configured with observer group %s',
      binding.key,
      group,
    );
    return group;
  }

  /**
   * Sort the life cycle observer bindings so that we can start/stop them
   * in the right order. By default, we can start other observers before servers
   * and stop them in the reverse order
   * @param bindings - Life cycle observer bindings
   */
  protected sortObserverBindingsByGroup(
    bindings: Readonly<Binding<LifeCycleObserver>>[],
  ) {
    // Group bindings in a map
    const groupMap: Map<string, Readonly<Binding<LifeCycleObserver>>[]> =
      new Map();
    sortBindingsByPhase(
      bindings,
      CoreTags.LIFE_CYCLE_OBSERVER_GROUP,
      this.options.orderedGroups,
    );
    for (const binding of bindings) {
      const group = this.getObserverGroup(binding);
      let bindingsInGroup = groupMap.get(group);
      if (bindingsInGroup == null) {
        bindingsInGroup = [];
        groupMap.set(group, bindingsInGroup);
      }
      bindingsInGroup.push(binding);
    }
    // Create an array for group entries
    const groups: LifeCycleObserverGroup[] = [];
    for (const [group, bindingsInGroup] of groupMap) {
      groups.push({group, bindings: bindingsInGroup});
    }
    return groups;
  }

  /**
   * Notify an observer group of the given event
   * @param group - A group of bindings for life cycle observers
   * @param event - Event name
   */
  protected async notifyObservers(
    observers: LifeCycleObserver[],
    bindings: Readonly<Binding<LifeCycleObserver>>[],
    event: keyof LifeCycleObserver,
    opts: NotifyOptions = {},
  ) {
    if (!this.options.parallel) {
      let index = 0;
      for (const observer of observers) {
        const key = bindings[index].key;
        log.debug('Invoking %s observer for binding %s', event, key);
        index++;
        await this.invokeObserver(observer, event);
        opts.onNotified?.(key);
      }
      return;
    }

    // Parallel invocation
    const notifiers = observers.map(async (observer, index) => {
      const key = bindings[index].key;
      log.debug('Invoking %s observer for binding %s', event, key);
      await this.invokeObserver(observer, event);
      opts.onNotified?.(key);
    });
    if (!opts.settle) {
      await Promise.all(notifiers);
      return;
    }
    // `settle` exists for start-with-rollback. `Promise.all` rejects on the
    // FIRST failure while its siblings keep running, so a caller that starts
    // unwinding on that rejection races observers that are still starting —
    // and can miss one it then has to stop. Waiting for every settlement makes
    // `onNotified` complete before the error surfaces.
    const results = await Promise.allSettled(notifiers);
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => r.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `${event} failed`);
    }
  }

  /**
   * Invoke an observer for the given event
   * @param observer - A life cycle observer
   * @param event - Event name
   */
  protected async invokeObserver(
    observer: LifeCycleObserver,
    event: keyof LifeCycleObserver,
  ) {
    if (typeof observer[event] === 'function') {
      // Supply `undefined` for legacy callback function expected by
      // DataSource.stop()
      await invokeMethod(observer, event, this.context, [undefined], {
        skipInterceptors: true,
      });
    }
  }

  /**
   * Emit events to the observer groups
   * @param events - Event names
   * @param groups - Observer groups
   */
  protected async notifyGroups(
    events: (keyof LifeCycleObserver)[],
    groups: LifeCycleObserverGroup[],
    reverse = false,
    opts: NotifyOptions = {},
  ) {
    // The whole-app path is UNCHANGED, deliberately. It resolves the view once
    // and indexes into it, which is right when every observer is being notified
    // anyway. `opts.partial` takes the other route — see below.
    let observers: LifeCycleObserver[] = [];
    let bindings: readonly Readonly<Binding<LifeCycleObserver>>[] = [];
    if (!opts.partial) {
      observers = await this.observersView.values();
      bindings = this.observersView.bindings;
      const found = observers.some(observer =>
        events.some(e => typeof observer[e] === 'function'),
      );
      if (!found) return;
    }
    if (reverse) {
      // Do not reverse the original `groups` in place
      groups = [...groups].reverse();
    }
    for (const group of groups) {
      if (this.options.disabledGroups?.includes(group.group)) {
        log.debug('Notification skipped (Group is disabled): %s', group.group);
        continue;
      }
      const bindingsInGroup = reverse
        ? group.bindings.reverse()
        : group.bindings;

      let observersForGroup: LifeCycleObserver[];
      let bindingsForGroup: readonly Readonly<Binding<LifeCycleObserver>>[];
      if (opts.partial) {
        // Resolve ONLY this group's bindings. The whole-app path resolves every
        // observer in the app to notify a handful, which is pure waste on a
        // partial notify — and worse than waste for a TRANSIENT-scoped
        // observer, where "resolving" CONSTRUCTS one, so an observer nobody
        // asked about gets instantiated and thrown away on every plugin mount
        // or retraction.
        //
        // This also sidesteps an alignment hazard inherited from the other
        // path: `ContextView.resolve` drops null values from `observers` but
        // `bindings` keeps them, so `bindings.indexOf(binding)` can select the
        // wrong observer (or `undefined`) once anything resolves to null.
        // Pairing each observer with its own binding cannot drift.
        const pairs = await this.resolveObserverPairs(bindingsInGroup);
        observersForGroup = pairs.map(pr => pr.observer);
        bindingsForGroup = pairs.map(pr => pr.binding);
        // No `found` pre-check here: on the whole-app path it runs AFTER the
        // expensive resolve, so it never saved the resolution — only the loop.
        // `invokeObserver` already skips an observer lacking the method.
        if (!observersForGroup.length) continue;
      } else {
        observersForGroup = bindingsInGroup.map(
          binding => observers[bindings.indexOf(binding)],
        );
        bindingsForGroup = group.bindings;
      }

      for (const event of events) {
        log.debug('Beginning notification %s of %s...', event);
        await this.notifyObservers(
          observersForGroup,
          bindingsForGroup as Readonly<Binding<LifeCycleObserver>>[],
          event,
          opts,
        );
        log.debug('Finished notification %s of %s', event);
      }
    }
  }

  /**
   * Resolve each binding to its observer, keeping the two paired.
   *
   * Uses the same resolution shape as `ContextView.resolve`: a value that
   * resolves to null is dropped (an observer that is not there cannot be
   * notified), and resolution starts a fresh session rather than nesting in
   * the caller's, matching the view's own circular-dependency guard.
   */
  private async resolveObserverPairs(
    bindings: readonly Readonly<Binding<LifeCycleObserver>>[],
  ): Promise<
    {observer: LifeCycleObserver; binding: Readonly<Binding<LifeCycleObserver>>}[]
  > {
    const pairs: {
      observer: LifeCycleObserver;
      binding: Readonly<Binding<LifeCycleObserver>>;
    }[] = [];
    for (const binding of bindings) {
      const observer = await this.context.get<LifeCycleObserver>(binding.key, {
        optional: true,
      });
      if (observer != null) pairs.push({observer, binding});
    }
    return pairs;
  }

  /**
   * Notify all life cycle observers by group of `init`
   */
  public async init(): Promise<void> {
    log.debug('Initializing the %s...');
    const groups = this.getObserverGroupsByOrder();
    await this.notifyGroups(['init'], groups);
  }

  /**
   * Notify all life cycle observers by group of `start`
   */
  public async start(): Promise<void> {
    log.debug('Starting the %s...');
    const groups = this.getObserverGroupsByOrder();
    await this.notifyGroups(['start'], groups);
  }

  /**
   * Notify all life cycle observers by group of `stop`
   */
  public async stop(): Promise<void> {
    log.debug('Stopping the %s...');
    const groups = this.getObserverGroupsByOrder();
    // Stop in the reverse order
    await this.notifyGroups(['stop'], groups, true);
  }

  /**
   * Notify a SUBSET of observers of `stop`, selected by binding key.
   *
   * Reuses the full `stop()` path — reversed group order, `disabledGroups`,
   * the `parallel` setting, and `invokeMethod` argument injection — so a
   * partial retraction behaves like a shutdown restricted to those observers.
   * A plugin uninstall needs exactly this: stop what it is retracting, and
   * nothing else. See {@link selectGroups} for why the filtered arrays are
   * fresh copies.
   */
  public async stopObservers(keys: ReadonlySet<string>): Promise<void> {
    const groups = this.selectGroups(keys);
    if (!groups.length) return;
    await this.notifyGroups(['stop'], groups, true, {partial: true});
  }

  /**
   * Notify a SUBSET of observers of `init` then `start`, selected by binding
   * key — the additive counterpart of {@link stopObservers}.
   *
   * A plugin mounted into an ALREADY-RUNNING app needs exactly this. Its
   * observers are bound after `app.start()` has run, so the app-wide `init()`
   * and `start()` passes are long over and nothing would ever notify them: the
   * plugin mounts inert, silently, which is the worst failure shape available.
   *
   * The two events are two SEPARATE passes, not `notifyGroups(['init',
   * 'start'])`. `notifyGroups` iterates events *inside* each group, so the
   * single-call form yields `groupA.init, groupA.start, groupB.init,
   * groupB.start` — whereas `Application` runs `registry.init()` across every
   * group and only then `registry.start()`. An observer in a later group whose
   * `init` must precede an earlier group's `start` is served by the app-wide
   * ordering and broken by the interleaved one. Partial start reuses the real
   * ordering rather than approximating it.
   */
  public async startObservers(keys: ReadonlySet<string>): Promise<void> {
    const groups = this.selectGroups(keys);
    if (!groups.length) return;

    // TRANSACTIONAL. A partial start is the worst outcome available: the
    // caller's rollback unbinds, and an observer that already started then
    // keeps its sockets and timers alive while becoming UNREACHABLE — the full
    // `stop()` pass resolves observers through the view, which no longer
    // contains an unbound key. So nothing outside can ever stop it.
    //
    // Tracking has to be per-observer, not per-call: `notifyObservers` walks a
    // serial `await` loop (and `Promise.all` in parallel mode), so a throw
    // leaves the EARLIER observers started with no record of which. Hence
    // `onNotified`, and `settle` so a parallel sibling cannot still be starting
    // while we unwind.
    const started = new Set<string>();
    const track = {
      onNotified: (key: string) => void started.add(key),
      settle: true,
      partial: true,
    };
    try {
      await this.notifyGroups(['init'], groups, false, track);
      // `init` completing for every observer is not a reason to forget them:
      // `stop()` is the documented inverse of both, and an observer that
      // allocated in `init` still needs it.
      await this.notifyGroups(['start'], groups, false, track);
    } catch (err) {
      if (started.size) {
        try {
          await this.stopObservers(started);
        } catch (stopErr) {
          // The start failure is the caller's diagnosis and must survive; a
          // failed unwind is additional damage, reported alongside rather than
          // in place of it.
          throw new AggregateError(
            [err, stopErr],
            'observer start failed, and stopping the partially-started ' +
              'observers also failed',
          );
        }
      }
      throw err;
    }
  }

  /**
   * Notify a SUBSET of observers of `init` only — for a mount into an app that
   * has been initialized but not yet started.
   *
   * `Application.start()` is `if (!this._initialized) await this.init()`, so on
   * such an app `init` will never run again while its pending `registry.start()`
   * still notifies every bound observer. Sending `start` here too would
   * double-start them; sending nothing would leave them un-initialized. Without
   * this, the same plugin got a different lifecycle depending on when it
   * mounted.
   */
  public async initObservers(keys: ReadonlySet<string>): Promise<void> {
    const groups = this.selectGroups(keys);
    if (!groups.length) return;
    await this.notifyGroups(['init'], groups, false, {partial: true});
  }

  /**
   * Ordered observer groups restricted to `keys`, empty when nothing matches.
   *
   * The filtered arrays are fresh copies, which matters — `notifyGroups`
   * reverses `group.bindings` in place for the stop path, and a copy keeps that
   * mutation off the registry's own group objects. The binding objects
   * themselves are NOT copied: `notifyGroups` locates each observer by
   * `bindings.indexOf(binding)` against the live view, so identity must hold.
   */
  private selectGroups(keys: ReadonlySet<string>): LifeCycleObserverGroup[] {
    if (!keys.size) return [];
    // The view caches its bindings and is invalidated by context observers,
    // which are notified ASYNCHRONOUSLY. A partial notify is called precisely
    // because bindings just changed, so the cache is reliably stale at that
    // moment — a plugin mounted into a running app would find its brand-new
    // observer absent from every group and silently never start. Invalidate
    // first: `bindings` then re-runs the filter against the live registry.
    this.observersView.refresh();
    return this.getObserverGroupsByOrder()
      .map(g => ({...g, bindings: g.bindings.filter(b => keys.has(b.key))}))
      .filter(g => g.bindings.length > 0);
  }
}
