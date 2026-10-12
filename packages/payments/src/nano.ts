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
 * The subset of a Nano node's `block_info` response (with `json_block: true`)
 * the facilitator reads. Amounts and balances are decimal strings in raw
 * (1 XNO = 10^30 raw).
 */
export interface NanoBlockInfo {
  /** `"true"` once the block is cemented by the network. */
  confirmed: string;
  /** State block subtype: `send`, `receive`, `open`, `change`, `epoch`. */
  subtype?: string;
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
 */
export interface NanoRpc {
  blockInfo(hash: string): Promise<NanoBlockInfo>;
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

  async blockInfo(hash: string): Promise<NanoBlockInfo> {
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
    if (body.error) throw new Error(`nano rpc: ${body.error}`);
    if (!body.contents) throw new Error('nano rpc: malformed block_info');
    return body as NanoBlockInfo;
  }
}

/**
 * Records which send blocks have already paid for a call, so one block hash
 * pays once. `claim` must be atomic: it returns `true` only for the first
 * caller. The default is in-memory (lost on restart); back it with a shared
 * store in production.
 */
export interface NanoReplayStore {
  has(blockHash: string): boolean | Promise<boolean>;
  claim(blockHash: string): boolean | Promise<boolean>;
}

/** Default in-memory {@link NanoReplayStore}. */
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
  /** Spent block hashes. Default {@link InMemoryNanoReplayStore}. */
  replayStore?: NanoReplayStore;
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
 * broadcast: `verify` reads the block from a node and checks it is a
 * confirmed send to `payTo` of at least `maxAmountRequired` raw; `settle`
 * re-verifies and records the hash so it cannot pay twice. Any other payment
 * goes to `fallback` untouched.
 *
 * A block hash is a bearer proof: whoever presents a qualifying send first
 * gets the call. Use a persistent {@link NanoReplayStore} in production, or a
 * restart forgets which blocks have paid.
 */
export class NanoFacilitator implements X402Facilitator {
  private readonly rpc: NanoRpc;
  private readonly replay: NanoReplayStore;

  constructor(private readonly opts: NanoFacilitatorOptions = {}) {
    this.rpc = opts.rpc ?? new FetchNanoRpc();
    this.replay = opts.replayStore ?? new InMemoryNanoReplayStore();
  }

  async verify(
    payment: string,
    requirements: PaymentRequirements[],
  ): Promise<X402VerifyResult> {
    const nano = decodeNanoPayment(payment);
    if (!nano) return this.delegateVerify(payment, requirements);
    const checked = await this.check(nano, requirements);
    return checked.valid
      ? {valid: true}
      : {valid: false, reason: checked.reason};
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
    const checked = await this.check(nano, requirements);
    if (!checked.valid) return {success: false};
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

  private async check(
    nano: {blockHash: unknown},
    requirements: PaymentRequirements[],
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

    let block: NanoBlockInfo;
    let previous: NanoBlockInfo;
    try {
      block = await this.rpc.blockInfo(blockHash);
      if (block.confirmed !== 'true') return invalid('nano: not confirmed');
      if (block.contents.type !== 'state' || block.subtype !== 'send') {
        return invalid('nano: not a send block');
      }
      previous = await this.rpc.blockInfo(block.contents.previous);
    } catch (err) {
      return invalid(`nano: rpc error (${(err as Error).message})`);
    }

    const sent = rawAmount(previous.contents.balance, block.contents.balance);
    if (sent == null) return invalid('nano: unreadable balance');
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
  return {
    scheme: 'exact',
    network: NANO_MAINNET,
    maxAmountRequired: opts.amountRaw,
    asset: 'XNO',
    payTo: normalizeAccount(opts.payTo),
    resource: opts.resource,
    ...(opts.description != null ? {description: opts.description} : {}),
    ...(opts.mimeType != null ? {mimeType: opts.mimeType} : {}),
    ...(opts.maxTimeoutSeconds != null
      ? {maxTimeoutSeconds: opts.maxTimeoutSeconds}
      : {}),
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

function rawAmount(before: string, after: string): bigint | undefined {
  if (!RAW_RE.test(before) || !RAW_RE.test(after)) return undefined;
  const sent = BigInt(before) - BigInt(after);
  return sent > 0n ? sent : undefined;
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
