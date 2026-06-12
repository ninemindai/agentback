// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeAll} from 'vitest';
import {generateKeyPair, SignJWT, type CryptoKey} from 'jose';
import {JwtAccessTokenService} from '../../jwt-access-token.service.js';

const ISSUER = 'https://as.example.com/';
const AUDIENCE = 'urn:my-api';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPublicKey: CryptoKey;

/** Mint an RS256 access token, with per-test overrides. */
async function mint(
  claims: Record<string, unknown> = {},
  opts: {issuer?: string; audience?: string; expiresIn?: string} = {},
): Promise<string> {
  return new SignJWT({scope: 'widgets:read', ...claims})
    .setProtectedHeader({alg: 'RS256'})
    .setSubject((claims.sub as string) ?? 'user-1')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '2h')
    .sign(privateKey);
}

function service(): JwtAccessTokenService {
  return new JwtAccessTokenService(
    {issuer: ISSUER, audience: AUDIENCE},
    publicKey,
  );
}

describe('JwtAccessTokenService', () => {
  beforeAll(async () => {
    ({privateKey, publicKey} = await generateKeyPair('RS256'));
    ({publicKey: otherPublicKey} = await generateKeyPair('RS256'));
  });

  it('verifies a valid token and returns its claims', async () => {
    const token = await mint({sub: 'user-7', scope: 'a b'});
    const payload = await service().verify(token);
    expect(payload.sub).toBe('user-7');
    expect(payload.scope).toBe('a b');
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await mint({}, {issuer: 'https://evil.example.com/'});
    await expect(service().verify(token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects a token for the wrong audience', async () => {
    const token = await mint({}, {audience: 'urn:other-api'});
    await expect(service().verify(token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects an expired token', async () => {
    const token = await mint({}, {expiresIn: '-1h'});
    await expect(service().verify(token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects a token signed by a different key', async () => {
    const token = await mint();
    const wrongKeyService = new JwtAccessTokenService(
      {issuer: ISSUER, audience: AUDIENCE},
      otherPublicKey,
    );
    await expect(wrongKeyService.verify(token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('throws at construction when neither a key resolver nor a jwksUri is given', () => {
    expect(() => new JwtAccessTokenService({issuer: ISSUER})).toThrow();
  });
});
