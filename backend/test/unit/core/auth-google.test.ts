import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet } from 'jose';
import { GoogleKeysUnavailableError, GoogleTokenError, verifyFirebaseIdToken } from '../../../src/auth-google.js';
import { fakeIssuer, PROJECT, type FakeIssuer } from '../../firebase-fake.js';

let issuer: FakeIssuer;
let stranger: FakeIssuer;
let verify: (token: string) => ReturnType<typeof verifyFirebaseIdToken>;

beforeAll(async () => {
  issuer = await fakeIssuer('k1');
  stranger = await fakeIssuer('k1'); // same kid, different key: a forged signature
  const keys = createLocalJWKSet({ keys: [issuer.jwk] });
  verify = (token) => verifyFirebaseIdToken(token, { projectId: PROJECT, jwksUrl: 'http://unused.invalid', keys });
});

async function rejects(token: string | Promise<string>, pattern: RegExp): Promise<void> {
  const err = await verify(await token).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(GoogleTokenError);
  expect((err as Error).message).toMatch(pattern);
}

describe('verifyFirebaseIdToken', () => {
  it('accepts a Google token with a verified email and lower-cases the address', async () => {
    const id = await verify(await issuer.mint({ email: 'Intern@MagickVoice.com' }));
    expect(id).toEqual({ email: 'intern@magickvoice.com' });
  });

  it('rejects an empty token', async () => {
    await rejects('', /Missing ID token/);
  });

  it('rejects garbage', async () => {
    await rejects('not.a.jwt', /Invalid ID token/);
  });

  it('a key lookup that fails is a 503 "keys unavailable", not a bad token', async () => {
    const down = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await verifyFirebaseIdToken(await issuer.mint(), { projectId: PROJECT, jwksUrl: 'http://unused.invalid', keys: down }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GoogleKeysUnavailableError);
    expect((err as GoogleKeysUnavailableError).status).toBe(503);
  });

  it('an unknown kid is the token\'s fault (401), not the key source\'s', async () => {
    const other = await fakeIssuer('k2');
    await rejects(other.mint(), /Invalid ID token/);
  });

  it('tells the user less than the log: jose detail stays out of publicMessage', async () => {
    const err = (await verify('not.a.jwt').catch((e: unknown) => e)) as GoogleTokenError;
    expect(err.status).toBe(401);
    expect(err.publicMessage).toBe('Invalid sign-in token');
  });

  it('rejects a token signed by a key not in the set', async () => {
    await rejects(stranger.mint(), /Invalid ID token/);
  });

  it('rejects another project (aud)', async () => {
    await rejects(issuer.mint({}, { aud: 'someone-elses-project' }), /Invalid ID token/);
  });

  it('rejects another issuer', async () => {
    await rejects(issuer.mint({}, { iss: 'https://securetoken.google.com/someone-elses-project' }), /Invalid ID token/);
  });

  it('rejects an expired token', async () => {
    await rejects(issuer.mint({}, { iat: -7200, exp: -3600 }), /Invalid ID token/);
  });

  it('rejects a token issued in the future', async () => {
    await rejects(issuer.mint({}, { iat: 600, exp: 4000 }), /Invalid ID token/);
  });

  it('rejects an auth_time in the future', async () => {
    await rejects(issuer.mint({ auth_time: Math.floor(Date.now() / 1000) + 600 }), /auth_time/);
  });

  it('rejects a missing auth_time', async () => {
    await rejects(issuer.mint({ auth_time: undefined }), /auth_time/);
  });

  it('rejects a non-Google provider (an email/password account could claim any address)', async () => {
    await rejects(issuer.mint({ firebase: { sign_in_provider: 'password' } }), /Only Google/);
    await rejects(issuer.mint({ firebase: undefined }), /Only Google/);
  });

  it('rejects an unverified email', async () => {
    await rejects(issuer.mint({ email_verified: false }), /not verified/);
    await rejects(issuer.mint({ email_verified: 'true' }), /not verified/);
  });

  it('rejects a token with no email', async () => {
    await rejects(issuer.mint({ email: undefined }), /no email/);
  });
});
