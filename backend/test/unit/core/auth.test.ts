import { createHmac, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_USERNAME,
  authEnabled,
  DEFAULT_SESSION_TTL_MS,
  hmacEquals,
  hmacHex,
  SessionBook,
  tokenFromAuthorization,
  tokenFromRequest,
  tokenFromUrl,
  verifyLogin,
} from '../../../src/auth.js';
import { config } from '../../../src/config.js';

vi.mock('dotenv/config', () => ({}));

const SECRET = 'bench-hmac-secret';
const PASSWORD = 'correct-horse';
/** HMAC-SHA256("bench-hmac-secret", "correct-horse"), pinned independently of the code under test. */
const KNOWN = '5c844644fe1e7484b03b6f74b796afd7a10727ae5578a047bf404fda059a99d4';

describe('constants', () => {
  it('the only account is the fixed admin username', () => {
    expect(AUTH_USERNAME).toBe('admin@magickvoice.com');
  });

  it('the default session TTL is three hours', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(10_800_000);
  });
});

describe('authEnabled', () => {
  const saved = { pw: config.authPassword, sec: config.authHmacSecret };
  afterEach(() => {
    config.authPassword = saved.pw;
    config.authHmacSecret = saved.sec;
  });

  it.each([
    ['', '', false],
    ['pw', '', false],
    ['', 'sec', false],
    ['pw', 'sec', true],
  ])('password=%j secret=%j -> %j (both must be set)', (pw, sec, expected) => {
    config.authPassword = pw;
    config.authHmacSecret = sec;
    expect(authEnabled()).toBe(expected);
  });

  it('is off in the test environment (setup blanks both)', () => {
    expect(authEnabled()).toBe(false);
  });
});

describe('hmacHex', () => {
  it('matches the pinned HMAC-SHA256 vector', () => {
    expect(hmacHex(SECRET, PASSWORD)).toBe(KNOWN);
  });

  it('matches RFC 4231 test case 2', () => {
    expect(hmacHex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('is lowercase hex, 64 chars', () => {
    expect(hmacHex('k', 'v')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encodes key and message as UTF-8 (same as the browser login page)', async () => {
    const key = 'clé-🔑';
    const msg = 'pässwörd-日本';
    const enc = new TextEncoder();
    const k = await webcrypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await webcrypto.subtle.sign('HMAC', k, enc.encode(msg))).toString('hex');
    expect(hmacHex(key, msg)).toBe(sig);
    expect(hmacHex(key, msg)).toBe(createHmac('sha256', Buffer.from(key, 'utf8')).update(Buffer.from(msg, 'utf8')).digest('hex'));
  });

  it('accepts an empty key and an empty message', () => {
    expect(hmacHex('', '')).toBe('b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad');
  });

  it('depends on both key and message', () => {
    expect(hmacHex('a', 'x')).not.toBe(hmacHex('b', 'x'));
    expect(hmacHex('a', 'x')).not.toBe(hmacHex('a', 'y'));
  });
});

describe('hmacEquals', () => {
  it('accepts the matching digest', () => {
    expect(hmacEquals(SECRET, PASSWORD, KNOWN)).toBe(true);
  });

  it('is case-insensitive on the hex', () => {
    expect(hmacEquals(SECRET, PASSWORD, KNOWN.toUpperCase())).toBe(true);
    const mixed = [...KNOWN].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
    expect(hmacEquals(SECRET, PASSWORD, mixed)).toBe(true);
  });

  it('rejects the digest of a different password or under a different secret', () => {
    expect(hmacEquals(SECRET, 'wrong', KNOWN)).toBe(false);
    expect(hmacEquals('other-secret', PASSWORD, KNOWN)).toBe(false);
  });

  it('rejects a single flipped nibble', () => {
    const flipped = (KNOWN[0] === '0' ? '1' : '0') + KNOWN.slice(1);
    expect(hmacEquals(SECRET, PASSWORD, flipped)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['non-hex', 'not-hex'],
    ['hex with a 0x prefix', `0x${KNOWN}`],
    ['odd length', KNOWN.slice(0, 63)],
    ['truncated', KNOWN.slice(0, 16)],
    ['too long', `${KNOWN}00`],
    ['surrounding whitespace', ` ${KNOWN} `],
    ['a trailing newline', `${KNOWN}\n`],
  ])('rejects %s without throwing', (_label, presented) => {
    expect(() => hmacEquals(SECRET, PASSWORD, presented)).not.toThrow();
    expect(hmacEquals(SECRET, PASSWORD, presented)).toBe(false);
  });

  it('rejects a digest whose prefix is valid hex but tail is not (Buffer.from would silently stop)', () => {
    // Buffer.from(hex) truncates at the first bad pair; the regex must catch it first.
    expect(hmacEquals(SECRET, PASSWORD, `${KNOWN.slice(0, 62)}zz`)).toBe(false);
  });
});

describe('verifyLogin', () => {
  const expected = { username: AUTH_USERNAME, password: PASSWORD, hmacSecret: SECRET };

  it('accepts the static username plus the HMAC of the password', () => {
    expect(verifyLogin({ username: AUTH_USERNAME, hmac: KNOWN }, expected)).toBe(true);
  });

  it('rejects a different username even with a good HMAC', () => {
    expect(verifyLogin({ username: 'other@magickvoice.com', hmac: KNOWN }, expected)).toBe(false);
  });

  it('compares the username exactly (case and whitespace matter)', () => {
    expect(verifyLogin({ username: AUTH_USERNAME.toUpperCase(), hmac: KNOWN }, expected)).toBe(false);
    expect(verifyLogin({ username: ` ${AUTH_USERNAME}`, hmac: KNOWN }, expected)).toBe(false);
  });

  it('rejects the HMAC of a wrong password', () => {
    expect(verifyLogin({ username: AUTH_USERNAME, hmac: hmacHex(SECRET, 'nope') }, expected)).toBe(false);
  });

  it('rejects the plaintext password sent in place of the HMAC', () => {
    expect(verifyLogin({ username: AUTH_USERNAME, hmac: PASSWORD }, expected)).toBe(false);
  });

  it('rejects an empty HMAC', () => {
    expect(verifyLogin({ username: AUTH_USERNAME, hmac: '' }, expected)).toBe(false);
  });
});

describe('SessionBook', () => {
  it('issues 32-byte hex tokens for the given user, expiring TTL after now', () => {
    const book = new SessionBook(1000);
    const s = book.create(AUTH_USERNAME, 5_000);
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.username).toBe(AUTH_USERNAME);
    expect(s.expiresAt).toBe(6_000);
  });

  it('defaults to the three-hour TTL', () => {
    const s = new SessionBook().create(AUTH_USERNAME, 0);
    expect(s.expiresAt).toBe(DEFAULT_SESSION_TTL_MS);
  });

  it('issues a distinct token every time', () => {
    const book = new SessionBook();
    const tokens = new Set(Array.from({ length: 200 }, () => book.create(AUTH_USERNAME, 0).token));
    expect(tokens.size).toBe(200);
  });

  it('get returns the live session', () => {
    const book = new SessionBook(1000);
    const s = book.create(AUTH_USERNAME, 0);
    expect(book.get(s.token, 0)).toEqual(s);
    expect(book.get(s.token, 999)).toEqual(s);
  });

  it('a session is dead AT its expiry instant (<=), not one tick later', () => {
    const book = new SessionBook(1000);
    const s = book.create(AUTH_USERNAME, 0);
    expect(book.get(s.token, 1000)).toBeUndefined();
  });

  it('an expired session is deleted, so going back in time cannot revive it', () => {
    const book = new SessionBook(1000);
    const s = book.create(AUTH_USERNAME, 0);
    expect(book.get(s.token, 2000)).toBeUndefined();
    expect(book.get(s.token, 10)).toBeUndefined();
  });

  it.each([undefined, '', 'deadbeef', 'x'.repeat(64)])('get(%j) is a miss', (token) => {
    const book = new SessionBook();
    book.create(AUTH_USERNAME, 0);
    expect(book.get(token, 0)).toBeUndefined();
  });

  it('revoke drops the session immediately, and is harmless on unknown tokens', () => {
    const book = new SessionBook();
    const a = book.create(AUTH_USERNAME, 0);
    const b = book.create(AUTH_USERNAME, 0);
    book.revoke(a.token);
    expect(book.get(a.token, 0)).toBeUndefined();
    expect(book.get(b.token, 0)).toBeDefined(); // only the one revoked
    expect(() => book.revoke('never-issued')).not.toThrow();
    expect(() => book.revoke(a.token)).not.toThrow(); // twice
  });

  it('books are independent', () => {
    const one = new SessionBook();
    const two = new SessionBook();
    const s = one.create(AUTH_USERNAME, 0);
    expect(two.get(s.token, 0)).toBeUndefined();
  });

  describe('against the real clock (fake timers)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('create and get default `now` to Date.now()', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      const book = new SessionBook(60_000);
      const s = book.create(AUTH_USERNAME);
      expect(s.expiresAt).toBe(Date.parse('2026-10-20T12:01:00Z'));
      vi.advanceTimersByTime(59_999);
      expect(book.get(s.token)).toBeDefined();
      vi.advanceTimersByTime(1);
      expect(book.get(s.token)).toBeUndefined();
    });

    it('a 3h session survives 2h59m and is gone at 3h', () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const book = new SessionBook();
      const s = book.create(AUTH_USERNAME);
      vi.setSystemTime(DEFAULT_SESSION_TTL_MS - 60_000);
      expect(book.get(s.token)?.username).toBe(AUTH_USERNAME);
      vi.setSystemTime(DEFAULT_SESSION_TTL_MS);
      expect(book.get(s.token)).toBeUndefined();
    });
  });
});

describe('tokenFromAuthorization', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['BEARER abc123', 'abc123'],
    ['Bearer    abc123', 'abc123'],
    ['Bearer\tabc123', 'abc123'],
  ])('%j -> %j', (header, expected) => {
    expect(tokenFromAuthorization(header)).toBe(expected);
  });

  it.each([
    [undefined],
    [''],
    ['Bearer'],
    ['Bearer '],
    ['Basic dXNlcjpwYXNz'],
    ['abc123'],
    ['Bearer abc 123'],
    [' Bearer abc123'],
    ['Bearer abc123 '],
    ['Bearerabc123'],
  ])('%j -> undefined', (header) => {
    expect(tokenFromAuthorization(header)).toBeUndefined();
  });

  it('takes the first value of a repeated header', () => {
    expect(tokenFromAuthorization(['Bearer first', 'Bearer second'])).toBe('first');
  });

  it('an empty header array is no token', () => {
    expect(tokenFromAuthorization([])).toBeUndefined();
  });
});

describe('tokenFromUrl', () => {
  it.each([
    ['/ws/session?token=from-qs', 'from-qs'],
    ['/api/x?a=1&token=t2&b=2', 't2'],
    ['http://bench.example:8787/ws?token=abs', 'abs'],
    ['/ws?token=a%2Bb%20c', 'a+b c'],
    ['/ws?token=first&token=second', 'first'],
  ])('%j -> %j', (url, expected) => {
    expect(tokenFromUrl(url)).toBe(expected);
  });

  it.each([[undefined], [''], ['/ws/session'], ['/ws?tok=x'], ['/ws#token=frag']])('%j -> undefined', (url) => {
    expect(tokenFromUrl(url)).toBeUndefined();
  });

  it('an empty token parameter yields a falsy value, never a usable token', () => {
    expect(tokenFromUrl('/ws?token=')).toBeFalsy();
    expect(new SessionBook().get(tokenFromUrl('/ws?token='), 0)).toBeUndefined();
  });

  it('a URL that cannot be parsed is a miss, not a throw', () => {
    expect(() => tokenFromUrl('http://[::1')).not.toThrow();
    expect(tokenFromUrl('http://[::1')).toBeUndefined();
  });
});

describe('tokenFromRequest', () => {
  it('the Authorization header wins over the query and the URL', () => {
    expect(
      tokenFromRequest({
        headers: { authorization: 'Bearer from-header' },
        url: '/api/catalog?token=from-url',
        query: { token: 'from-query' },
      }),
    ).toBe('from-header');
  });

  it('the Express query is used when there is no header', () => {
    expect(tokenFromRequest({ headers: {}, url: '/api/catalog?token=from-url', query: { token: 'from-query' } })).toBe(
      'from-query',
    );
  });

  it('a raw ws upgrade (no Express query) falls back to the URL', () => {
    expect(tokenFromRequest({ headers: {}, url: '/ws/session?token=from-upgrade' })).toBe('from-upgrade');
  });

  it('a malformed header falls through to the query', () => {
    expect(tokenFromRequest({ headers: { authorization: 'Basic abc' }, query: { token: 'q' } })).toBe('q');
  });

  it('a non-string or empty query token is ignored in favour of the URL', () => {
    expect(tokenFromRequest({ headers: {}, url: '/x?token=u', query: { token: ['a', 'b'] } })).toBe('u');
    expect(tokenFromRequest({ headers: {}, url: '/x?token=u', query: { token: '' } })).toBe('u');
    expect(tokenFromRequest({ headers: {}, url: '/x?token=u', query: { token: 42 } })).toBe('u');
  });

  it('nothing anywhere is no token', () => {
    expect(tokenFromRequest({ headers: {} })).toBeUndefined();
    expect(tokenFromRequest({ headers: {}, url: '/x', query: {} })).toBeUndefined();
  });

  it('round-trips with a SessionBook', () => {
    const book = new SessionBook();
    const s = book.create(AUTH_USERNAME, 0);
    const token = tokenFromRequest({ headers: { authorization: `Bearer ${s.token}` } });
    expect(book.get(token, 0)?.username).toBe(AUTH_USERNAME);
  });
});
