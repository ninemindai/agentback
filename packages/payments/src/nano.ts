// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  PaymentRequirements,
  X402Facilitator,
  X402SettleResult,
  X402VerifyResult,
} from './types.js';

/** The x402 `network` id for Nano (XNO) mainnet. */
export const NANO_MAINNET = 'nano:mainnet';

/** Default public Nano node RPC endpoint. */
export const DEFAULT_NANO_RPC_URL = 'https://rpc.nano.to';

/**
 * Default `maxTimeoutSeconds` of a {@link nanoRequirement}: how old a send
 * block may be, by the node's `local_timestamp`, and still pay.
 */
export const DEFAULT_NANO_MAX_TIMEOUT_SECONDS = 300;

/** How far ahead of our clock a node's `local_timestamp` may run. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * How long `settle` honours the reference time `verify` checked a block
 * against, so a send that passed `verify` at the edge of the window is not
 * refused as too old by the `settle` that follows it.
 */
const VERIFIED_HOLD_SECONDS = 300;

/**
 * The subset of a Nano node's `block_info` response (with `json_block: true`)
 * the facilitator reads. Amounts and balances are decimal strings in raw
 * (1 XNO = 10^30 raw).
 */
export interface NanoBlockInfo {
  /** `"true"` once the block is cemented by the network. */
  confirmed: string;
  /** State block subtype: `send`, `receive`, `open`, `change`, `epoch`. */
  subtype?: string;
  /** Raw amount this block transferred, as computed by the node. */
  amount?: string;
  /**
   * Unix seconds at which the answering node first saw the block (`"0"` when
   * it does not know, e.g. for blocks from before it recorded the time).
   */
  local_timestamp?: string;
  contents: {
    type: string;
    account: string;
    previous: string;
    /** Account balance after this block, in raw. */
    balance: string;
    link: string;
    link_as_account?: string;
  };
}

/**
 * Read access to a Nano node. Only `block_info` is needed: the facilitator
 * holds no key and broadcasts nothing. Injectable so tests run without a
 * network.
 *
 * `blockInfo` resolves `undefined` when the node does not know the block, and
 * throws when the node cannot answer (outage, HTTP error, malformed reply).
 */
export interface NanoRpc {
  blockInfo(hash: string): Promise<NanoBlockInfo | undefined>;
}

/**
 * Thrown by {@link NanoFacilitator} when the Nano node cannot answer. It is
 * not a verdict on the payment, so it is thrown rather than reported as an
 * invalid payment: the request fails (no call is granted) and the payer can
 * retry the same block hash. The message is generic; the node's own error is
 * kept as `cause` for logs only.
 */
export class NanoRpcUnavailableError extends Error {
  constructor(options?: {cause?: unknown}) {
    super('nano: node unavailable', options);
    this.name = 'NanoRpcUnavailableError';
  }
}

export interface FetchNanoRpcOptions {
  /** Node RPC URL. Default {@link DEFAULT_NANO_RPC_URL}. */
  url?: string;
  /** `fetch` implementation. Default the global `fetch`. */
  fetch?: typeof fetch;
}

/** {@link NanoRpc} over HTTP JSON-RPC (`POST {action: 'block_info'}`). */
export class FetchNanoRpc implements NanoRpc {
  constructor(private readonly opts: FetchNanoRpcOptions = {}) {}

  async blockInfo(hash: string): Promise<NanoBlockInfo | undefined> {
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(this.opts.url ?? DEFAULT_NANO_RPC_URL, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({action: 'block_info', json_block: 'true', hash}),
    });
    if (!res.ok) throw new Error(`nano rpc http ${res.status}`);
    const body = (await res.json()) as Partial<NanoBlockInfo> & {
      error?: string;
    };
    if (body.error === 'Block not found') return undefined;
    if (body.error) throw new Error(`nano rpc: ${body.error}`);
    if (!body.contents) throw new Error('nano rpc: malformed block_info');
    return body as NanoBlockInfo;
  }
}

/**
 * Records which send blocks have already paid for a call, so one block hash
 * pays once. `claim` must be atomic: it returns `true` only for the first
 * caller. Required by {@link NanoFacilitator}: back it with shared, durable
 * storage in production. {@link InMemoryNanoReplayStore} is for tests and
 * single-process development only.
 *
 * A claimed hash should be kept forever. The recency window is measured
 * against the answering node's `local_timestamp`, which our clock cannot
 * check, so only a store that never forgets keeps a hash from paying twice
 * whatever a node reports. A store that expires entries must say so in
 * `retentionSeconds`; {@link NanoFacilitator} then refuses any requirement
 * whose `maxTimeoutSeconds` plus twice the allowed clock skew (60s: a node
 * running ahead, and our instances' clocks differing) exceeds it, and such a
 * store still trusts the node's `local_timestamp` to age an expired hash out
 * of the window.
 */
export interface NanoReplayStore {
  has(blockHash: string): boolean | Promise<boolean>;
  claim(blockHash: string): boolean | Promise<boolean>;
  /**
   * Seconds a claimed hash is kept, when the store expires entries. Leave
   * unset for a store that keeps every claim forever.
   */
  readonly retentionSeconds?: number;
}

/**
 * In-memory {@link NanoReplayStore}, for tests and single-process
 * development. It forgets on restart and is not shared between instances, so
 * a block that paid on one process (or before a restart) pays again on
 * another while it is still inside the `maxTimeoutSeconds` window.
 */
export class InMemoryNanoReplayStore implements NanoReplayStore {
  private readonly used = new Set<string>();

  has(blockHash: string): boolean {
    return this.used.has(blockHash);
  }

  claim(blockHash: string): boolean {
    if (this.used.has(blockHash)) return false;
    this.used.add(blockHash);
    return true;
  }
}

export interface NanoFacilitatorOptions {
  /** Facilitator for every non-Nano payment (e.g. USDC on Base), unchanged. */
  fallback?: X402Facilitator;
  /** Node RPC. Default {@link FetchNanoRpc} against {@link DEFAULT_NANO_RPC_URL}. */
  rpc?: NanoRpc;
  /**
   * Spent block hashes. Required, and must be shared and durable in
   * production: a store that forgets (restart) or is not shared (several
   * instances) lets one block pay more than once.
   */
  replayStore: NanoReplayStore;
  /** Clock for the recency check, Unix ms. Injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * An {@link X402Facilitator} that accepts Nano (XNO) beside the rails the
 * `fallback` facilitator already handles. A Nano payment is an x402 payment
 * payload for network `nano:mainnet` whose `payload.blockHash` names a send
 * block the payer has already published:
 *
 * ```json
 * {"x402Version":1,"scheme":"exact","network":"nano:mainnet",
 *  "payload":{"blockHash":"<64 hex>"}}
 * ```
 *
 * (base64-encoded in `X-PAYMENT`, as x402 payloads are; plain JSON is also
 * read). Nano sends are final once confirmed, so there is nothing to sign or
 * broadcast: `verify` reads the block from a node (one `block_info` call) and
 * checks it is a confirmed send to `payTo` of at least `maxAmountRequired`
 * raw, first seen by the node no more than `maxTimeoutSeconds` ago; `settle`
 * re-verifies (judging recency at the time `verify` accepted the block) and
 * records the hash so it cannot pay twice. Any other payment goes to
 * `fallback` untouched. If the node cannot answer, both throw
 * {@link NanoRpcUnavailableError} instead of reporting an invalid payment.
 *
 * A block hash is a bearer proof: nothing ties the send to the caller who
 * presents it, so whoever presents a qualifying recent send first gets the
 * call. The recency window bounds which sends count (old sends and donations
 * to `payTo` do not), but it does not stop a watcher of `payTo` presenting a
 * payer's fresh hash before the payer does.
 */
export class NanoFacilitator implements X402Facilitator {
  private readonly rpc: NanoRpc;
  private readonly replay: NanoReplayStore;
  /** Block hash -> the time (Unix s) `verify` accepted it against. */
  private readonly verified = new Map<string, number>();

  constructor(private readonly opts: NanoFacilitatorOptions) {
    if (!opts?.replayStore) {
      throw new Error('NanoFacilitator: replayStore is required');
    }
    const retention = opts.replayStore.retentionSeconds;
    if (
      retention !== undefined &&
      !(Number.isFinite(retention) && retention > 0)
    ) {
      throw new Error(
        `NanoFacilitator: invalid replayStore.retentionSeconds: ${retention}`,
      );
    }
    this.rpc = opts.rpc ?? new FetchNanoRpc();
    this.replay = opts.replayStore;
  }

  async verify(
    payment: string,
    requirements: PaymentRequirements[],
  ): Promise<X402VerifyResult> {
    const nano = decodeNanoPayment(payment);
    if (!nano) return this.delegateVerify(payment, requirements);
    const now = this.nowSeconds();
    const checked = await this.check(nano, requirements, now);
    if (!checked.valid) return {valid: false, reason: checked.reason};
    for (const [hash, at] of this.verified) {
      if (at < now - VERIFIED_HOLD_SECONDS) this.verified.delete(hash);
    }
    this.verified.set(checked.blockHash, now);
    return {valid: true};
  }

  async settle(
    payment: string,
    requirements: PaymentRequirements[],
  ): Promise<X402SettleResult> {
    const nano = decodeNanoPayment(payment);
    if (!nano) {
      if (!this.opts.fallback) return {success: false};
      return this.opts.fallback.settle(payment, requirements);
    }
    // Check the block against the same time `verify` accepted it at, so a
    // send near the edge of the window does not pass `verify` and then fail
    // here only because the clock moved. Everything else is re-checked, and
    // the replay claim below still decides whether it pays.
    const now = this.nowSeconds();
    const hash =
      typeof nano.blockHash === 'string' ? nano.blockHash.toUpperCase() : '';
    const verifiedAt = this.verified.get(hash);
    const at =
      verifiedAt !== undefined &&
      verifiedAt <= now &&
      verifiedAt >= now - VERIFIED_HOLD_SECONDS
        ? verifiedAt
        : now;
    const checked = await this.check(nano, requirements, at);
    if (!checked.valid) return {success: false};
    this.verified.delete(checked.blockHash);
    if (!(await this.replay.claim(checked.blockHash))) return {success: false};
    return {
      success: true,
      payload: {
        network: NANO_MAINNET,
        blockHash: checked.blockHash,
        payer: checked.payer,
        payTo: checked.payTo,
        amount: checked.amount,
      },
    };
  }

  private async delegateVerify(
    payment: string,
    requirements: PaymentRequirements[],
  ): Promise<X402VerifyResult> {
    if (!this.opts.fallback) {
      return {valid: false, reason: 'unsupported payment'};
    }
    return this.opts.fallback.verify(payment, requirements);
  }

  private nowSeconds(): number {
    return Math.floor((this.opts.now ?? Date.now)() / 1000);
  }

  private async check(
    nano: {blockHash: unknown},
    requirements: PaymentRequirements[],
    now: number,
  ): Promise<
    | {valid: false; reason: string}
    | {
        valid: true;
        blockHash: string;
        payer: string;
        payTo: string;
        amount: string;
      }
  > {
    const invalid = (reason: string) => ({valid: false as const, reason});
    if (typeof nano.blockHash !== 'string' || !HASH_RE.test(nano.blockHash)) {
      return invalid('nano: malformed block hash');
    }
    const blockHash = nano.blockHash.toUpperCase();
    const accepts = requirements.filter(r => r.network === NANO_MAINNET);
    if (accepts.length === 0) return invalid('nano: not an accepted network');
    if (await this.replay.has(blockHash)) {
      return invalid('nano: block already used');
    }

    let block: NanoBlockInfo | undefined;
    try {
      block = await this.rpc.blockInfo(blockHash);
    } catch (err) {
      throw new NanoRpcUnavailableError({cause: err});
    }
    if (!block) return invalid('nano: block not found');
    if (block.confirmed !== 'true') return invalid('nano: not confirmed');
    if (block.contents.type !== 'state' || block.subtype !== 'send') {
      return invalid('nano: not a send block');
    }

    // The node reports the transferred amount itself, so the previous block
    // (which may be a legacy block with another shape) is never read.
    const sent = rawAmount(block.amount);
    if (sent == null) return invalid('nano: unreadable amount');
    const seenAt = unixSeconds(block.local_timestamp);
    // Fail closed: a node that cannot say when it saw the block cannot show
    // the send is recent.
    if (seenAt == null || seenAt > now + CLOCK_SKEW_SECONDS) {
      return invalid('nano: block time unknown');
    }
    const age = now - seenAt;
    const dest = normalizeAccount(block.contents.link_as_account ?? '');

    let reason = 'nano: wrong destination';
    for (const req of accepts) {
      if (!isValidNanoAddress(req.payTo)) {
        reason = 'nano: invalid payTo address';
        continue;
      }
      if (normalizeAccount(req.payTo) !== dest) continue;
      if (!RAW_RE.test(req.maxAmountRequired)) {
        reason = 'nano: invalid maxAmountRequired';
        continue;
      }
      if (sent < BigInt(req.maxAmountRequired)) {
        reason = 'nano: amount too low';
        continue;
      }
      const window = req.maxTimeoutSeconds ?? DEFAULT_NANO_MAX_TIMEOUT_SECONDS;
      const retention = this.replay.retentionSeconds;
      if (
        retention !== undefined &&
        retention < window + 2 * CLOCK_SKEW_SECONDS
      ) {
        reason = 'nano: replay store retention shorter than window';
        continue;
      }
      if (age > window) {
        reason = 'nano: block too old';
        continue;
      }
      return {
        valid: true,
        blockHash,
        payer: normalizeAccount(block.contents.account),
        payTo: dest,
        amount: sent.toString(),
      };
    }
    return invalid(reason);
  }
}

export interface NanoRequirementOptions {
  /** Recipient `nano_` account. Validated (checksum included). */
  payTo: string;
  /** Amount in raw (1 XNO = 10^30 raw), as a decimal string. */
  amountRaw: string;
  /** The resource being paid for (URL/path). */
  resource: string;
  description?: string;
  mimeType?: string;
  /**
   * How old the send block may be, in seconds by the node's
   * `local_timestamp`, and still pay. Enforced by {@link NanoFacilitator}.
   * Default {@link DEFAULT_NANO_MAX_TIMEOUT_SECONDS}.
   */
  maxTimeoutSeconds?: number;
}

/**
 * Build the x402 {@link PaymentRequirements} entry for a Nano payment, to put
 * in an `accepts` list beside the existing ones. Throws on an invalid
 * address or amount so a misconfiguration fails at boot, not at payment time.
 */
export function nanoRequirement(
  opts: NanoRequirementOptions,
): PaymentRequirements {
  if (!isValidNanoAddress(opts.payTo)) {
    throw new Error(`Invalid Nano address: ${opts.payTo}`);
  }
  if (!RAW_RE.test(opts.amountRaw) || BigInt(opts.amountRaw) === 0n) {
    throw new Error(`Invalid Nano raw amount: ${opts.amountRaw}`);
  }
  const maxTimeoutSeconds =
    opts.maxTimeoutSeconds ?? DEFAULT_NANO_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error(`Invalid maxTimeoutSeconds: ${opts.maxTimeoutSeconds}`);
  }
  return {
    scheme: 'exact',
    network: NANO_MAINNET,
    maxAmountRequired: opts.amountRaw,
    asset: 'XNO',
    payTo: normalizeAccount(opts.payTo),
    resource: opts.resource,
    ...(opts.description != null ? {description: opts.description} : {}),
    ...(opts.mimeType != null ? {mimeType: opts.mimeType} : {}),
    maxTimeoutSeconds,
  };
}

/**
 * Whether `address` is a well-formed Nano account (`nano_` or legacy `xrb_`
 * prefix, base32 public key, and a matching blake2b-40 checksum).
 */
export function isValidNanoAddress(address: string): boolean {
  const m = /^(?:nano|xrb)_([13][13456789abcdefghijkmnopqrstuwxyz]{59})$/.exec(
    address,
  );
  if (!m) return false;
  const body = m[1];
  const key = base32Decode(body.slice(0, 52), 260);
  const checksum = base32Decode(body.slice(52), 40);
  if (!key || !checksum) return false;
  const publicKey = key.slice(key.length - 32);
  if (key.length !== 33 || key[0] !== 0) return false;
  const expected = blake2b(publicKey, 5).reverse();
  return expected.every((b, i) => b === checksum[i]);
}

const HASH_RE = /^[0-9A-Fa-f]{64}$/;
const RAW_RE = /^\d+$/;
const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';

function normalizeAccount(account: string): string {
  return account.startsWith('xrb_') ? `nano_${account.slice(4)}` : account;
}

function rawAmount(amount: string | undefined): bigint | undefined {
  if (amount == null || !RAW_RE.test(amount)) return undefined;
  const sent = BigInt(amount);
  return sent > 0n ? sent : undefined;
}

/** A positive Unix-seconds decimal string, or `undefined`. */
function unixSeconds(value: string | undefined): number | undefined {
  if (value == null || !RAW_RE.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** Parse an x402 payment payload for Nano; `undefined` means "not Nano". */
function decodeNanoPayment(payment: string): {blockHash: unknown} | undefined {
  const trimmed = payment.trim();
  let json: string;
  if (trimmed.startsWith('{')) {
    json = trimmed;
  } else {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return undefined;
    json = Buffer.from(trimmed, 'base64').toString('utf8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const p = parsed as {network?: unknown; payload?: unknown};
  if (p.network !== NANO_MAINNET) return undefined;
  const inner = (p.payload ?? {}) as {blockHash?: unknown};
  return {blockHash: inner.blockHash};
}

/** Decode Nano base32 into the big-endian bytes of a `bits`-bit number. */
function base32Decode(text: string, bits: number): Uint8Array | undefined {
  let value = 0n;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return undefined;
    value = (value << 5n) | BigInt(i);
  }
  const out = new Uint8Array(Math.ceil(bits / 8));
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return value === 0n ? out : undefined;
}

// BLAKE2b (RFC 7693), unkeyed, variable output length. Nano address
// checksums need a 5-byte digest, which node:crypto's fixed `blake2b512`
// cannot produce (the output length is part of the parameter block).
const MASK64 = (1n << 64n) - 1n;
const BLAKE2B_IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function blake2bCompress(
  h: bigint[],
  block: Uint8Array,
  counter: bigint,
  last: boolean,
): void {
  const m: bigint[] = [];
  const view = new DataView(block.buffer, block.byteOffset, 128);
  for (let i = 0; i < 16; i++) m.push(view.getBigUint64(i * 8, true));
  const v = [...h, ...BLAKE2B_IV];
  v[12] ^= counter & MASK64;
  v[13] ^= counter >> 64n;
  if (last) v[14] ^= MASK64;
  const g = (
    a: number,
    b: number,
    c: number,
    d: number,
    x: bigint,
    y: bigint,
  ) => {
    v[a] = (v[a] + v[b] + x) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b with an `outLen`-byte digest (1..64). */
function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  const h = [...BLAKE2B_IV];
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  let offset = 0;
  while (input.length - offset > 128) {
    blake2bCompress(
      h,
      input.subarray(offset, offset + 128),
      BigInt(offset + 128),
      false,
    );
    offset += 128;
  }
  const lastBlock = new Uint8Array(128);
  lastBlock.set(input.subarray(offset));
  blake2bCompress(h, lastBlock, BigInt(input.length), true);
  const out = new Uint8Array(64);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) view.setBigUint64(i * 8, h[i], true);
  return out.slice(0, outLen);
}
