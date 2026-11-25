import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

/**
 * A stand-in for Firebase's token issuer: an RS256 key pair, a JWKS served on
 * 127.0.0.1, and a minter for ID tokens shaped like the ones the Google popup
 * returns. It agrees with our reading of Firebase's docs BY CONSTRUCTION — a
 * green test here proves the checks are wired, not that Google signs this way.
 */

export const PROJECT = 'grindelwald-test';

export interface FakeIssuer {
  kid: string;
  jwk: JWK;
  privateKey: CryptoKey;
  mint(claims?: Record<string, unknown>, opts?: MintOptions): Promise<string>;
}

export interface MintOptions {
  kid?: string;
  alg?: string;
  key?: CryptoKey;
  /** Seconds relative to now. */
  iat?: number;
  exp?: number;
  aud?: string;
  iss?: string;
  sub?: string;
}

export async function fakeIssuer(kid = 'test-key-1'): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    kid,
    jwk,
    privateKey,
    async mint(claims = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const body = {
        email: 'intern@magickvoice.com',
        email_verified: true,
        auth_time: now - 5,
        firebase: { sign_in_provider: 'google.com', identities: {} },
        ...claims,
      };
      return new SignJWT(body)
        .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? kid, typ: 'JWT' })
        .setIssuedAt(now + (opts.iat ?? 0))
        .setExpirationTime(now + (opts.exp ?? 3600))
        .setAudience(opts.aud ?? PROJECT)
        .setIssuer(opts.iss ?? `https://securetoken.google.com/${PROJECT}`)
        .setSubject(opts.sub ?? 'uid-123')
        .sign(opts.key ?? privateKey);
    },
  };
}

/** Serves `{ keys }` as a JWKS on 127.0.0.1. */
export async function serveJwks(keys: JWK[]): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
    res.end(JSON.stringify({ keys }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/jwks`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
