/**
 * Checks that the key set `auth-google.ts` verifies Firebase ID tokens against
 * is the one Firebase documents.
 *
 *   npm run firebase:keys
 *
 * Needs no key and no Firebase project — both endpoints are public.
 *
 * WHY THIS EXISTS
 *
 * Firebase's "verify ID tokens using a third-party JWT library" page names the
 * signing keys by their x509 certificate URL:
 *
 *   https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com
 *
 * The backend instead reads the same service account's JWK set,
 *
 *   https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com
 *
 * because `jose` consumes a JWK set (and caches it, refetching on an unknown
 * `kid`) directly. That page does not name the JWK URL, so "they serve the same
 * keys" is a measurement, and this is it: every `kid` in each must appear in the
 * other, with the same RSA modulus and exponent. Keys rotate every few days, so
 * a one-off match proves little; a mismatch on any run means stop and switch to
 * the documented x509 URL.
 *
 * First measured 2026-11-25: two RS256 keys, same kids, same moduli.
 */
import { X509Certificate } from 'node:crypto';
import { FIREBASE_DEFAULT_JWKS_URL } from '../src/config.js';

const X509_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

async function get(url: string): Promise<{ body: unknown; maxAge: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const maxAge = /max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1] ?? '?';
  return { body: await r.json(), maxAge };
}

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const jwks = await get(FIREBASE_DEFAULT_JWKS_URL);
const x509 = await get(X509_URL);
const keys = (jwks.body as { keys?: Jwk[] }).keys ?? [];
const certs = x509.body as Record<string, string>;

console.log(`JWK set   ${keys.length} keys, max-age ${jwks.maxAge}s`);
console.log(`x509 set  ${Object.keys(certs).length} certs, max-age ${x509.maxAge}s`);

check(keys.length > 0, 'the JWK set is non-empty');
check(
  JSON.stringify(keys.map((k) => k.kid).sort()) === JSON.stringify(Object.keys(certs).sort()),
  'both endpoints list the same key ids',
);
for (const key of keys) {
  check(key.kty === 'RSA' && (key.alg ?? 'RS256') === 'RS256', `${key.kid}: RSA / RS256`);
  const pem = certs[key.kid];
  if (!pem) continue;
  const fromCert = new X509Certificate(pem).publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  check(fromCert.n === key.n && fromCert.e === key.e, `${key.kid}: same modulus and exponent as its x509 certificate`);
}

console.log(failures ? `\n${failures} FAILED` : '\nthe JWK set and the documented x509 certificates are the same keys');
process.exit(failures ? 1 : 0);
