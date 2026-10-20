import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/*
 * `config.ts` loads `.env` via dotenv at import. dotenv never overrides a set
 * variable, but it DOES fill one a test deleted — so a developer's `.env` would
 * leak into the "unset" cases. Mocked out: every value here comes from the test.
 */
vi.mock('dotenv/config', () => ({}));

const BACKEND = fileURLToPath(new URL('../../../', import.meta.url));

/** Every variable config.ts reads, so each case starts from "nothing set". */
const CONFIG_VARS = [
  'PORT',
  'HOST',
  'CORS_ORIGINS',
  'LOG_AUDIO',
  'SESSION_AUDIO',
  'SESSION_DIR',
  'STATIC_DIR',
  'SESSION_AUDIO_MAX_MINUTES',
  'AUTH_PASSWORD',
  'AUTH_HMAC_SECRET',
  'AUTH_SESSION_HOURS',
] as const;

type ConfigVar = (typeof CONFIG_VARS)[number];

async function loadConfig(env: Partial<Record<ConfigVar, string>> = {}) {
  vi.resetModules();
  for (const k of CONFIG_VARS) vi.stubEnv(k, env[k]);
  return import('../../../src/config.js');
}

describe('config defaults (nothing set)', () => {
  it('produces the documented defaults', async () => {
    const { config } = await loadConfig();
    expect(config).toEqual({
      port: 8787,
      host: undefined,
      corsOrigins: ['http://localhost:5173'],
      logAudio: false,
      recordAudio: true,
      sessionDir: 'data/sessions',
      staticDir: undefined,
      recordAudioMaxMinutes: 60,
      authPassword: '',
      authHmacSecret: '',
      authSessionTtlMs: 3 * 3_600_000,
    });
  });
});

describe('config.port', () => {
  it('reads a numeric PORT', async () => {
    expect((await loadConfig({ PORT: '9000' })).config.port).toBe(9000);
  });

  /*
   * BUG (src/config.ts:4): `Number(process.env.PORT ?? 8787)` — `??` only
   * catches undefined, so `PORT=` (empty, as compose `PORT=${PORT:-}` or a
   * blanked .env line produce) is `Number('')` = 0, and `server.listen(0)`
   * binds a RANDOM ephemeral port while logging "localhost:0". Every other
   * string setting here treats empty as unset (`||`), and the numeric ones are
   * sanitised; PORT is the one that is not.
   */
  it.fails('treats an empty PORT as unset, not as port 0 (BUG: yields 0)', async () => {
    expect((await loadConfig({ PORT: '' })).config.port).toBe(8787);
  });
});

describe('config string settings', () => {
  it('HOST: empty is unset, a value is kept', async () => {
    expect((await loadConfig({ HOST: '' })).config.host).toBeUndefined();
    expect((await loadConfig({ HOST: '0.0.0.0' })).config.host).toBe('0.0.0.0');
  });

  it('STATIC_DIR: empty is unset, a value is kept', async () => {
    expect((await loadConfig({ STATIC_DIR: '' })).config.staticDir).toBeUndefined();
    expect((await loadConfig({ STATIC_DIR: '/srv/ui' })).config.staticDir).toBe('/srv/ui');
  });

  it('CORS_ORIGINS is split on commas and trimmed', async () => {
    const { config } = await loadConfig({ CORS_ORIGINS: 'http://a.test, http://b.test ,http://c.test' });
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test', 'http://c.test']);
  });

  it('a single CORS origin is a one-element list', async () => {
    expect((await loadConfig({ CORS_ORIGINS: 'https://bench.example' })).config.corsOrigins).toEqual([
      'https://bench.example',
    ]);
  });

  it('SESSION_DIR is used verbatim when set', async () => {
    expect((await loadConfig({ SESSION_DIR: '/tmp/records' })).config.sessionDir).toBe('/tmp/records');
  });

  it('AUTH_PASSWORD / AUTH_HMAC_SECRET are read verbatim', async () => {
    const { config } = await loadConfig({ AUTH_PASSWORD: 'pw', AUTH_HMAC_SECRET: 'sec' });
    expect(config.authPassword).toBe('pw');
    expect(config.authHmacSecret).toBe('sec');
  });
});

describe('config flags', () => {
  it.each([
    [undefined, false],
    ['1', true],
    ['0', false],
    ['true', false],
    ['', false],
  ])('LOG_AUDIO=%j -> %j (only "1" turns it on)', async (raw, expected) => {
    expect((await loadConfig({ LOG_AUDIO: raw })).config.logAudio).toBe(expected);
  });

  it.each([
    [undefined, true],
    ['0', false],
    ['1', true],
    ['', true],
    ['false', true],
  ])('SESSION_AUDIO=%j -> %j (on by default, only "0" turns it off)', async (raw, expected) => {
    expect((await loadConfig({ SESSION_AUDIO: raw })).config.recordAudio).toBe(expected);
  });
});

describe('config.recordAudioMaxMinutes (sanitised once, here)', () => {
  it.each([
    ['5', 5],
    ['0.5', 0.5],
    [' 7 ', 7],
    ['1e1', 10],
    ['1440', 1440], // the recorder, not config, clamps to the WAV size limit
  ])('accepts %j as %j', async (raw, expected) => {
    expect((await loadConfig({ SESSION_AUDIO_MAX_MINUTES: raw })).config.recordAudioMaxMinutes).toBe(expected);
  });

  it.each([undefined, '', '0', '-1', '-0.5', 'abc', 'NaN', 'Infinity', '-Infinity', '5min'])(
    'falls back to 60 for %j — never quotes junk back to the user',
    async (raw) => {
      expect((await loadConfig({ SESSION_AUDIO_MAX_MINUTES: raw })).config.recordAudioMaxMinutes).toBe(60);
    },
  );
});

describe('config.authSessionTtlMs', () => {
  it.each([
    ['1', 3_600_000],
    ['0.5', 1_800_000],
    ['1.5', 5_400_000],
    ['24', 86_400_000],
  ])('AUTH_SESSION_HOURS=%j -> %j ms', async (raw, expected) => {
    expect((await loadConfig({ AUTH_SESSION_HOURS: raw })).config.authSessionTtlMs).toBe(expected);
  });

  it.each(['25', '1000', '1e9'])('caps %j hours at 24h (setTimeout overflow guard)', async (raw) => {
    expect((await loadConfig({ AUTH_SESSION_HOURS: raw })).config.authSessionTtlMs).toBe(86_400_000);
  });

  it.each([undefined, '', '0', '-3', 'abc', 'Infinity', 'NaN'])('falls back to 3h for %j', async (raw) => {
    expect((await loadConfig({ AUTH_SESSION_HOURS: raw })).config.authSessionTtlMs).toBe(10_800_000);
  });

  it('is always a whole number of ms', async () => {
    const { config } = await loadConfig({ AUTH_SESSION_HOURS: '0.123456789' });
    expect(Number.isInteger(config.authSessionTtlMs)).toBe(true);
    expect(config.authSessionTtlMs).toBe(Math.round(0.123456789 * 3_600_000));
  });
});

describe('credentials()', () => {
  it('is a snapshot of the environment at call time, not at import time', async () => {
    const { credentials } = await loadConfig();
    vi.stubEnv('CARTESIA_API_KEY', 'late-key');
    expect(credentials().CARTESIA_API_KEY).toBe('late-key');
  });

  it('returns a copy: a provider mutating it cannot change process.env', async () => {
    const { credentials } = await loadConfig();
    vi.stubEnv('MURF_API_KEY', 'original');
    const creds = credentials();
    creds.MURF_API_KEY = 'tampered';
    creds.NEW_THING = 'x';
    expect(process.env.MURF_API_KEY).toBe('original');
    expect(process.env.NEW_THING).toBeUndefined();
    expect(credentials()).not.toBe(creds);
  });
});

describe('redactSecrets', () => {
  it('returns text with nothing secret in it unchanged', async () => {
    const { redactSecrets } = await loadConfig();
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('connection reset by peer')).toBe('connection reset by peer');
  });

  it('scrubs a secret-named env var of 12+ chars, labelled with its key', async () => {
    const { redactSecrets } = await loadConfig();
    vi.stubEnv('SARVAM_API_KEY', 'sk_abcdefghijklmnop');
    expect(redactSecrets('401: bad key sk_abcdefghijklmnop')).toBe('401: bad key «SARVAM_API_KEY redacted»');
  });

  it('scrubs every occurrence, not just the first', async () => {
    const { redactSecrets } = await loadConfig();
    vi.stubEnv('CARTESIA_API_KEY', 'cartesia-0123456789');
    expect(redactSecrets('a=cartesia-0123456789&b=cartesia-0123456789')).toBe(
      'a=«CARTESIA_API_KEY redacted»&b=«CARTESIA_API_KEY redacted»',
    );
  });

  it('scrubs several different secrets in one message', async () => {
    const { redactSecrets } = await loadConfig();
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-0000000000');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret-1111111111');
    expect(redactSecrets('{"o":"sk-openai-0000000000","a":"aws-secret-1111111111"}')).toBe(
      '{"o":"«OPENAI_API_KEY redacted»","a":"«AWS_SECRET_ACCESS_KEY redacted»"}',
    );
  });

  it.each(['MY_API_KEY', 'my_api_key', 'AWS_SESSION_TOKEN', 'SOME_SECRET', 'DB_PASSWORD', 'GOOGLE_APPLICATION_CREDENTIALS'])(
    'treats %s as secret-named (case-insensitive substring match)',
    async (name) => {
      const { redactSecrets } = await loadConfig();
      vi.stubEnv(name, 'value-long-enough-1');
      expect(redactSecrets('x value-long-enough-1 y')).toBe(`x «${name} redacted» y`);
    },
  );

  it('leaves long values of non-secret-named variables alone (no false positives)', async () => {
    const { redactSecrets } = await loadConfig();
    vi.stubEnv('SOME_LONG_SETTING', 'abcdefghijklmnopqrstuvwxyz');
    expect(redactSecrets('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('has a 12-character floor for env values: 11 is left, 12 is scrubbed', async () => {
    const { redactSecrets } = await loadConfig();
    vi.stubEnv('SHORT_KEY', '12345678901');
    vi.stubEnv('EXACT_KEY', 'abcdefghijkl');
    expect(redactSecrets('12345678901 abcdefghijkl')).toBe('12345678901 «EXACT_KEY redacted»');
  });

  it('skips blank secret-named variables (the test setup blanks every vendor key)', async () => {
    const { redactSecrets } = await loadConfig();
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(redactSecrets('nothing to see')).toBe('nothing to see');
  });

  it('always scrubs AUTH_PASSWORD and AUTH_HMAC_SECRET, even below the 12-char floor', async () => {
    const { redactSecrets } = await loadConfig({ AUTH_PASSWORD: 'shortpw', AUTH_HMAC_SECRET: 'shortsec' });
    expect(redactSecrets('pw=shortpw k=shortsec pw=shortpw')).toBe(
      'pw=«AUTH_PASSWORD redacted» k=«AUTH_HMAC_SECRET redacted» pw=«AUTH_PASSWORD redacted»',
    );
  });

  it('reads the login secrets from config, so a runtime change to config is honoured', async () => {
    const { config, redactSecrets } = await loadConfig();
    config.authPassword = 'hunter2';
    expect(redactSecrets('pw hunter2')).toBe('pw «AUTH_PASSWORD redacted»');
    config.authPassword = '';
    expect(redactSecrets('pw hunter2')).toBe('pw hunter2');
  });

  it('a long AUTH_PASSWORD is scrubbed once, under its own label', async () => {
    const { redactSecrets } = await loadConfig({ AUTH_PASSWORD: 'a-long-login-password' });
    expect(redactSecrets('a-long-login-password')).toBe('«AUTH_PASSWORD redacted»');
  });

  /*
   * BUG (src/config.ts:82-87 runs before :89-93): the login secrets are replaced FIRST and with
   * no floor, so a short password that happens to occur inside an API key
   * breaks the key apart before the env pass looks for it. The env pass then
   * cannot find the full key, and the rest of the key goes to the browser:
   *   AUTH_PASSWORD=pass  SARVAM_API_KEY=sk_live_pass_0123456789abcdef
   *   redactSecrets('key=sk_live_pass_0123456789abcdef')
   *   -> 'key=sk_live_«AUTH_PASSWORD redacted»_0123456789abcdef'
   * 24 of the key's 29 characters leak. Replacing longest values first would
   * close it.
   */
  it.fails('does not leak most of an API key that contains the (short) login password (BUG)', async () => {
    const { redactSecrets } = await loadConfig({ AUTH_PASSWORD: 'pass', AUTH_HMAC_SECRET: 'unrelated-secret' });
    vi.stubEnv('SARVAM_API_KEY', 'sk_live_pass_0123456789abcdef');
    const out = redactSecrets('key=sk_live_pass_0123456789abcdef');
    expect(out).not.toContain('0123456789abcdef');
  });

  describe('termination (run in a child process — a hang cannot be interrupted in-process)', () => {
    function redactInChild(env: Record<string, string>, input: string, timeoutMs: number) {
      const script =
        "import('./src/config.ts').then((m) => process.stdout.write(JSON.stringify(m.redactSecrets(process.env.REDACT_INPUT ?? ''))))";
      return spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
        cwd: BACKEND,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          AUTH_PASSWORD: '', AUTH_HMAC_SECRET: '', ...env, REDACT_INPUT: input },
        encoding: 'utf8',
        timeout: timeoutMs,
      });
    }

    it('control: the harness runs redactSecrets to completion', () => {
      const res = redactInChild({ AUTH_PASSWORD: 'shortpw' }, 'pw=shortpw', 15_000);
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout)).toBe('pw=«AUTH_PASSWORD redacted»');
    });

    /*
     * BUG (src/config.ts:87, and the same loop at :93): `while
     * (out.includes(value)) out = out.replace(value, `«${key} redacted»`)`
     * never terminates when `value` occurs inside its own replacement marker.
     * Any login secret that is a substring of "«AUTH_PASSWORD redacted»" /
     * "«AUTH_HMAC_SECRET redacted»" — "redacted", "SECRET", "HMAC", or any
     * single letter of "redacted" — hangs the event loop (and grows the string
     * until OOM) on the first error message that contains it, i.e. the whole
     * server freezes. Repro:
     *   AUTH_PASSWORD=redacted node --import tsx -e \
     *     "import('./src/config.ts').then(m=>m.redactSecrets('redacted'))"   # never returns
     */
    it.fails('terminates when a login secret occurs inside its own redaction marker (BUG: hangs)', () => {
      const res = redactInChild({ AUTH_PASSWORD: 'redacted' }, 'the word redacted', 3_000);
      expect(res.signal).toBeNull();
      expect(res.status).toBe(0);
    });
  });
});
