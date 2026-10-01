// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {EventSubscription, SubscriptionStore} from './ports.js';

/**
 * Per-process {@link SubscriptionStore}. Correct for one instance because the
 * server grants short TTLs: a restart loses every subscription, and each
 * client re-subscribes on its next refresh (the sketch's soft-state
 * argument). Expired entries are dropped lazily on read.
 */
export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly subs = new Map<string, EventSubscription>();
  private readonly verified = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(sub: EventSubscription): Promise<void> {
    this.subs.set(sub.id, sub);
  }

  async get(id: string): Promise<EventSubscription | undefined> {
    const sub = this.subs.get(id);
    if (sub && !this.live(sub)) {
      this.subs.delete(id);
      return undefined;
    }
    return sub;
  }

  async delete(id: string): Promise<boolean> {
    const sub = await this.get(id);
    return sub ? this.subs.delete(id) : false;
  }

  async listByEvent(name: string): Promise<EventSubscription[]> {
    return this.sweep().filter(s => s.name === name);
  }

  async countByPrincipal(principal: string): Promise<number> {
    return this.sweep().filter(s => s.principal === principal).length;
  }

  async isVerified(principal: string, url: string): Promise<boolean> {
    const key = verificationKey(principal, url);
    const until = this.verified.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.verified.delete(key);
      return false;
    }
    return true;
  }

  async markVerified(
    principal: string,
    url: string,
    ttlMs: number,
  ): Promise<void> {
    this.verified.set(verificationKey(principal, url), this.now() + ttlMs);
  }

  private live(sub: EventSubscription): boolean {
    return sub.expiresAt === null || sub.expiresAt > this.now();
  }

  /** Every live subscription, dropping expired ones on the way. */
  private sweep(): EventSubscription[] {
    const out: EventSubscription[] = [];
    for (const [id, sub] of this.subs) {
      if (this.live(sub)) out.push(sub);
      else this.subs.delete(id);
    }
    return out;
  }
}

function verificationKey(principal: string, url: string): string {
  return JSON.stringify([principal, url]);
}
