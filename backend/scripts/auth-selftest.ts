/**
 * Checks the naive login layer: HMAC-SHA256 of the password, session issue
 * and expiry, token extraction. Needs no API key and touches no network.
 *
 *   npm run auth:selftest
 *
 * HMAC is a keyed digest, not encryption. This asserts the backend recomputes
 * the same digest the login page will send (UTF-8 key + message, hex output)
 * and that a stale token is a miss.
 */
import { createHmac, webcrypto } from 'node:crypto';
import {
  AUTH_USERNAME,
  hmacEquals,
  hmacHex,
  SessionBook,
  tokenFromAuthorization,
  tokenFromRequest,
  tokenFromUrl,
  verifyLogin,
} from '../src/auth.js';
import { config, redactSecrets } from '../src/config.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
    console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const SECRET = 'bench-hmac-secret';
const PASSWORD = 'correct-horse';
/** HMAC-SHA256("bench-hmac-secret", "correct-horse") — pinned, not derived in this file. */
const KNOWN = '5c844644fe1e7484b03b6f74b796afd7a10727ae5578a047bf404fda059a99d4';
const known = createHmac('sha256', SECRET).update(PASSWORD, 'utf8').digest('hex');

console.log('\nHMAC construction');
{
  check('pinned vector still matches Node createHmac', known, KNOWN);
  check('hmacHex matches the pinned SHA-256 hex', hmacHex(SECRET, PASSWORD), KNOWN);
  check('hmacEquals accepts the matching digest', hmacEquals(SECRET, PASSWORD, known), true);
  check('hmacEquals is case-insensitive on hex', hmacEquals(SECRET, PASSWORD, known.toUpperCase()), true);
  check('hmacEquals rejects a wrong password', hmacEquals(SECRET, 'wrong', known), false);
  check('hmacEquals rejects a garbled digest', hmacEquals(SECRET, PASSWORD, 'not-hex'), false);
  check('hmacEquals rejects a truncated digest', hmacEquals(SECRET, PASSWORD, known.slice(0, 16)), false);
}

console.log('\nlogin verification');
{
  const expected = { username: AUTH_USERNAME, password: PASSWORD, hmacSecret: SECRET };
  check(
    'accepts the static username + HMAC of AUTH_PASSWORD',
    verifyLogin({ username: AUTH_USERNAME, hmac: known }, expected),
    true,
  );
  check(
    'rejects a different username even with a good HMAC',
    verifyLogin({ username: 'other@magickvoice.com', hmac: known }, expected),
    false,
  );
  check(
    'rejects a HMAC of the wrong password',
    verifyLogin({ username: AUTH_USERNAME, hmac: hmacHex(SECRET, 'nope') }, expected),
    false,
  );
}

console.log('\nsessions');
{
  const book = new SessionBook(3 * 60 * 60 * 1000);
  const session = book.create(AUTH_USERNAME, 1_000);
  check('issued token is 32 bytes hex', session.token.length, 64);
  check('username is the static account', session.username, AUTH_USERNAME);
  check('expires 3 hours after `now`', session.expiresAt, 1_000 + 3 * 60 * 60 * 1000);
  check('get returns a live session', book.get(session.token, 1_000)?.username, AUTH_USERNAME);
  check('get rejects a missing token', book.get(undefined, 1_000), undefined);
  check('get rejects a forged token', book.get('deadbeef', 1_000), undefined);
  check('get rejects an expired token', book.get(session.token, session.expiresAt), undefined);
  check('an expired token cannot be reused', book.get(session.token, session.expiresAt + 1), undefined);

  const short = new SessionBook(50);
  const brief = short.create(AUTH_USERNAME, 0);
  check('a 50ms TTL is already dead at t=50', short.get(brief.token, 50), undefined);

  const live = book.create(AUTH_USERNAME, 10_000);
  book.revoke(live.token);
  check('revoke drops the session immediately', book.get(live.token, 10_000), undefined);
}

console.log('\ntoken extraction');
{
  check('Bearer header', tokenFromAuthorization('Bearer abc123'), 'abc123');
  check('bearer is case-insensitive', tokenFromAuthorization('bearer abc123'), 'abc123');
  check('missing header', tokenFromAuthorization(undefined), undefined);
  check('query string on the upgrade URL', tokenFromUrl('/ws/session?token=from-qs'), 'from-qs');
  check('header wins over the query', tokenFromRequest({
    headers: { authorization: 'Bearer from-header' },
    url: '/api/catalog?token=from-qs',
    query: { token: 'from-query' },
  }), 'from-header');
  check('Express query is used when there is no header', tokenFromRequest({
    headers: {},
    url: '/api/catalog',
    query: { token: 'from-query' },
  }), 'from-query');
  check('upgrade URL with no Express query (the real ws IncomingMessage)', tokenFromRequest({
    headers: {},
    url: '/ws/session?token=from-upgrade',
  }), 'from-upgrade');
}

console.log('\nshort login secrets are still redacted');
{
  const savedPassword = config.authPassword;
  const savedSecret = config.authHmacSecret;
  try {
    config.authPassword = 'shortpw';
    config.authHmacSecret = 'shortsec';
    check('AUTH_PASSWORD shorter than 12 is still scrubbed', redactSecrets('pw=shortpw'), 'pw=«AUTH_PASSWORD redacted»');
    check('AUTH_HMAC_SECRET shorter than 12 is still scrubbed', redactSecrets('k=shortsec'), 'k=«AUTH_HMAC_SECRET redacted»');
  } finally {
    config.authPassword = savedPassword;
    config.authHmacSecret = savedSecret;
  }
}

{
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    'raw',
    enc.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, enc.encode(PASSWORD));
  const web = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  check('Web Crypto HMAC matches the pinned vector (same construction as the login page)', web, KNOWN);
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED`);
  process.exit(1);
}
console.log(`\n${passed} ok`);
