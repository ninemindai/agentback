// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * A self-signed certificate for `hooks.test` (EC P-256, valid until 2126),
 * TEST USE ONLY. It lets the pinned transport be exercised over real TLS:
 * the test resolver maps `hooks.test` to 127.0.0.1, and the handshake only
 * succeeds if SNI and certificate verification still use the original
 * hostname — the property IP pinning must not break.
 */
export const HOOKS_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBlzCCAT6gAwIBAgIURX1F+P5+8G1ms2erxr9H/u6CYUUwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKaG9va3MudGVzdDAgFw0yNjEwMDEyMjUxMTdaGA8yMTI2MDkw
NzIyNTExN1owFTETMBEGA1UEAwwKaG9va3MudGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABJKimBNngQwgrEQvBaEHrppXZyuWk3Yrrjl8Dh46c6orWBA+907u
f9xZa8kyImzA7UKlGjeexVwdCW8VxXWmTmOjajBoMB0GA1UdDgQWBBQmsQ9m3ilO
MuWPqcY/7/ozZ9sJNjAfBgNVHSMEGDAWgBQmsQ9m3ilOMuWPqcY/7/ozZ9sJNjAP
BgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCmhvb2tzLnRlc3QwCgYIKoZIzj0E
AwIDRwAwRAIgcDFFqqudEyHsAaifNzcrTcOiWOP0pjENKC04xHsn1RMCIGN9fkM4
FjcNyhzsjPPtaYzHjEiOf1dK8vigcGFwa0ix
-----END CERTIFICATE-----
`;

export const HOOKS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnVSPmjDv2rT+Vkr0
Ouk9NVAk7n/SxP9uS7PbKknseE2hRANCAASSopgTZ4EMIKxELwWhB66aV2crlpN2
K645fA4eOnOqK1gQPvdO7n/cWWvJMiJswO1CpRo3nsVcHQlvFcV1pk5j
-----END PRIVATE KEY-----
`;
