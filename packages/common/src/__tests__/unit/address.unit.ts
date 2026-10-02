// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {
  ipVersion,
  isBlockedAddress,
  isPublicAddress,
} from '../../utils/address.js';

describe('address classifier', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '100.63.255.255', // just below CGNAT
    '172.32.0.1', // just above 172.16/12
    '198.20.0.1', // just above 198.18/15
    '2606:4700:4700::1111',
    '2a00:1450:4001:82a::200e',
    '::ffff:8.8.8.8', // mapped public IPv4
    '64:ff9b::808:808', // NAT64 of 8.8.8.8
    '2002:0808:0808::1', // 6to4 of 8.8.8.8
    '[2606:4700:4700::1111]',
  ])('%s is public', ip => {
    expect(isPublicAddress(ip)).toBe(true);
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it.each([
    // IPv4 special-purpose registry
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.10', // TEST-NET-1
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7', // TEST-NET-2
    '203.0.113.9', // TEST-NET-3
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6 special-purpose registry
    '::',
    '::1',
    '::127.0.0.1', // deprecated IPv4-compatible
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:7f00:1', // mapped loopback, hex form
    '64:ff9b::7f00:1', // NAT64 of loopback
    '64:ff9b:1::1', // local-use NAT64
    '100::1', // discard-only
    '2001::1', // Teredo
    '2001:db8::1', // documentation
    '2002:7f00:0001::1', // 6to4 of loopback
    '3fff::1', // documentation
    '5f00::1', // SRv6
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    '[::1]',
  ])('%s is blocked', ip => {
    expect(isPublicAddress(ip)).toBe(false);
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['', 'localhost', 'example.com', '1.2.3', '01.2.3.4', '256.1.1.1'])(
    'refuses a non-IP literal %j',
    value => {
      expect(ipVersion(value)).toBe(0);
      expect(isBlockedAddress(value)).toBe(true);
    },
  );

  it.each([
    ['1:2:3:4:5:6:7:8:9', 0],
    ['1::2::3', 0],
    ['12345::1', 0],
    ['1:2:3:4:5:6:7:8', 6],
    ['1:2:3:4:5:6:1.2.3.4', 6],
    ['::', 6],
    ['8.8.8.8', 4],
  ] as const)('ipVersion(%j) is %d', (value, expected) => {
    expect(ipVersion(value)).toBe(expected);
  });
});
