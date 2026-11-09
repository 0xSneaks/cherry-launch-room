import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHERRY_APP_ID } from '../spike/constants';
import { CHERRY_ISSUER, bearerToken, verifyCherryToken } from './cherryAuth';

let priv: CryptoKey;
let jwks: { keys: JWK[] };
let otherPriv: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  priv = kp.privateKey as CryptoKey;
  jwks = { keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };
  otherPriv = (await generateKeyPair('RS256')).privateKey as CryptoKey;
});

const now = () => Math.floor(Date.now() / 1000);

async function token(over: Record<string, unknown> = {}, opts: { key?: CryptoKey; iss?: string; aud?: string | null; exp?: number } = {}) {
  const jwt = new SignJWT({ app_id: CHERRY_APP_ID, sub: 'WaLLet1111111111111111111111111111111111111', cherry_id: 'cid_42', tier: 'unverified', ...over })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? CHERRY_ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? now() + 300);
  if (opts.aud !== null) jwt.setAudience(opts.aud ?? CHERRY_APP_ID);
  return jwt.sign(opts.key ?? priv);
}

const verify = (t: string | null) => verifyCherryToken(t, { jwks: jwks as never, clockTolerance: 0 });

describe('verifyCherryToken', () => {
  it('accepts a valid token and keys the user by cherry_id', async () => {
    const r = await verify(await token());
    expect(r).toMatchObject({ ok: true, identity: { userKey: 'cid_42', tier: 'unverified' } });
  });
  it('falls back to sub when cherry_id is absent', async () => {
    const r = await verify(await token({ cherry_id: undefined }));
    expect(r.ok && r.identity.userKey).toBe('WaLLet1111111111111111111111111111111111111');
  });
  it('returns payment_wallet as the signing wallet when present, else sub', async () => {
    const pw = await verify(await token({ payment_wallet: 'PayWaLLet22222222222222222222222222222222222' }));
    expect(pw.ok && pw.identity.wallet).toBe('PayWaLLet22222222222222222222222222222222222');
    const sub = await verify(await token());
    expect(sub.ok && sub.identity.wallet).toBe('WaLLet1111111111111111111111111111111111111');
  });
  it('rejects a token for another app (aud)', async () => {
    expect(await verify(await token({}, { aud: 'another-app-id' }))).toMatchObject({ ok: false, status: 401, code: 'AUDIENCE_MISMATCH' });
  });
  it('rejects a token whose app_id is another app', async () => {
    expect(await verify(await token({ app_id: 'another-app-id' }, { aud: null }))).toMatchObject({ ok: false, status: 401 });
  });
  it('rejects a wrong issuer', async () => {
    expect(await verify(await token({}, { iss: 'https://evil.example' }))).toMatchObject({ ok: false, status: 401, code: 'ISSUER_MISMATCH' });
  });
  it('rejects an expired token', async () => {
    expect(await verify(await token({}, { exp: now() - 60 }))).toMatchObject({ ok: false, status: 401, code: 'TOKEN_EXPIRED' });
  });
  it('rejects a token signed by another key', async () => {
    expect(await verify(await token({}, { key: otherPriv }))).toMatchObject({ ok: false, status: 401 });
  });
  it('rejects garbage and a missing token', async () => {
    expect(await verify('not.a.jwt')).toMatchObject({ ok: false, status: 401 });
    expect(await verify(null)).toMatchObject({ ok: false, status: 400, code: 'TOKEN_MISSING' });
  });
});

describe('bearerToken', () => {
  it('reads only a Bearer header', () => {
    expect(bearerToken('Bearer a.b.c')).toBe('a.b.c');
    expect(bearerToken('Basic a.b.c')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
