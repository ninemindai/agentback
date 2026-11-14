// Copyright Zhaohui Feng 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it, expect} from 'vitest';
import {
  NANO_MAINNET,
  NanoFacilitator,
  nanoRequirement,
  type NanoBlockInfo,
} from '../../nano.js';
import {FileNanoReplayStore} from '../../nano-replay-file.js';

const MERCHANT =
  'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const XNO = 10n ** 30n;
const PRICE = (XNO / 100n).toString();
const NOW_S = 1_800_000_000;
const A = 'A'.repeat(64);
const B = 'B'.repeat(64);

function claimsPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'nano-claims-')), 'claims.txt');
}

describe('FileNanoReplayStore', () => {
  it('claims a block hash once', () => {
    const store = new FileNanoReplayStore(claimsPath());
    expect(store.has(A)).toBe(false);
    expect(store.claim(A)).toBe(true);
    expect(store.claim(A)).toBe(false);
    expect(store.has(A)).toBe(true);
  });

  it('still refuses a claimed hash after a restart', () => {
    const path = claimsPath();
    new FileNanoReplayStore(path).claim(A);
    const reopened = new FileNanoReplayStore(path);
    expect(reopened.has(A)).toBe(true);
    expect(reopened.claim(A)).toBe(false);
    expect(reopened.claim(B)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(`${A}\n${B}\n`);
  });

  it('drops a last line cut short by a crash', () => {
    const path = claimsPath();
    new FileNanoReplayStore(path).claim(A);
    appendFileSync(path, B.slice(0, 20));
    const reopened = new FileNanoReplayStore(path);
    expect(reopened.has(A)).toBe(true);
    expect(reopened.has(B)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(`${A}\n`);
    expect(reopened.claim(B)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(`${A}\n${B}\n`);
  });

  it('refuses to open a damaged file', () => {
    const path = claimsPath();
    writeFileSync(path, `${A}\nnot-a-hash\n`);
    expect(() => new FileNanoReplayStore(path)).toThrow(/line 2/);
  });

  it('refuses a lower-case or malformed hash', () => {
    const store = new FileNanoReplayStore(claimsPath());
    expect(() => store.claim('a'.repeat(64))).toThrow();
    expect(() => store.claim('XYZ')).toThrow();
  });

  it('keeps a NanoFacilitator from paying twice across a restart', async () => {
    const path = claimsPath();
    const send: NanoBlockInfo = {
      confirmed: 'true',
      subtype: 'send',
      amount: PRICE,
      local_timestamp: String(NOW_S - 10),
      contents: {
        type: 'state',
        account: MERCHANT,
        previous: B,
        balance: XNO.toString(),
        link: '0'.repeat(64),
        link_as_account: MERCHANT,
      },
    };
    const accepts = [
      nanoRequirement({payTo: MERCHANT, amountRaw: PRICE, resource: '/w'}),
    ];
    const pay = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: NANO_MAINNET,
        payload: {blockHash: A},
      }),
    ).toString('base64');
    const boot = () =>
      new NanoFacilitator({
        rpc: {blockInfo: async h => (h === A ? send : undefined)},
        replayStore: new FileNanoReplayStore(path),
        now: () => NOW_S * 1000,
      });

    expect((await boot().settle(pay, accepts)).success).toBe(true);
    const restarted = boot();
    expect(await restarted.verify(pay, accepts)).toEqual({
      valid: false,
      reason: 'nano: block already used',
    });
    expect((await restarted.settle(pay, accepts)).success).toBe(false);
  });
});
