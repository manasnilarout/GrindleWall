import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LegUsage, SessionSummary, StartConfig } from '../../../src/shared/protocol.js';
import { SessionStore, promptSha256, sessionStore, speechSecondsOf } from '../../../src/store/SessionStore.js';
import { UsageLedger } from '../../../src/pricing/UsageLedger.js';

const CONFIG: StartConfig = {
  mode: 'pipeline',
  sttProviderId: 'sarvam-stt',
  sttModelId: 'saaras:v3-realtime@fast',
  llmProviderId: 'google-llm',
  llmModelId: 'gemini-3.5-flash-lite',
  ttsProviderId: 'cartesia-tts',
  ttsModelId: 'sonic-3.6',
  systemPrompt: 'Be brief.',
  language: 'en',
  turnDetection: 'server_vad',
};
const BE_BRIEF_SHA256 = '213c22ed7234eb11116e1e88f314c73cb3a019b5c87fe224b6ce5665bd9ec50e';

const ttsTotal = (audioSeconds?: number): LegUsage => ({
  leg: 'tts', providerId: 'cartesia-tts', modelId: 'sonic-3.6', unit: 'characters',
  inputUnits: 0, outputUnits: 100, source: 'local', ...(audioSeconds === undefined ? {} : { audioSeconds }),
});

function summary(recordId: string, o: Partial<SessionSummary> = {}): SessionSummary {
  return {
    recordId,
    sessionId: `sock-${recordId}`,
    mode: 'pipeline',
    label: `label ${recordId}`,
    config: CONFIG,
    startedAt: 1_000,
    endedAt: 6_000,
    durationMs: 5_000,
    turnCount: 1,
    totals: [ttsTotal(1.25)],
    costUsd: 0.0213,
    costInr: 2.0141,
    unpriced: [],
    turns: [{ turnId: 1, at: 5_000, legs: [ttsTotal(1.25)], costUsd: 0.0213, costInr: 2.0141, unpriced: [] }],
    latency: { ttfaMedianMs: 500 },
    usdPerInr: 1 / 94.43,
    ...o,
  };
}

let base: string;
let dir: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'grindelwald-store-'));
  dir = join(base, 'sessions');
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const files = async (d = dir) => (await readdir(d)).sort();

describe('SessionStore — round trip', () => {
  it('writes one pretty-printed JSON file per record and reads it back intact', async () => {
    const store = new SessionStore(dir, 0);
    const s = summary('rec-1');
    await store.save(s);
    expect(await files()).toEqual(['rec-1.json']);
    const raw = await readFile(join(dir, 'rec-1.json'), 'utf8');
    expect(raw).toBe(JSON.stringify(s, null, 2));
    expect(await store.get('rec-1')).toEqual(s);
  });

  it('creates the directory (recursively) on first use', async () => {
    const deep = join(base, 'a', 'b', 'c');
    const store = new SessionStore(deep, 0);
    await store.save(summary('r'));
    expect(existsSync(join(deep, 'r.json'))).toBe(true);
  });

  it('is rewritten after every turn — one record, not one per save, last write wins', async () => {
    const store = new SessionStore(dir, 0);
    const one = summary('conv', { turnCount: 1 });
    await store.save(one);
    expect((await store.list())[0].turnCount).toBe(1);
    const two = summary('conv', {
      turnCount: 2,
      costUsd: 0.0426,
      turns: [...one.turns, { turnId: 2, at: 9_000, legs: [ttsTotal(2)], costUsd: 0.0213, costInr: 2.0141, unpriced: [] }],
    });
    await store.save(two);
    expect(await files()).toEqual(['conv.json']);
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].turnCount).toBe(2);
    expect(list[0].costUsd).toBe(0.0426);
    expect((await store.get('conv'))?.turns).toHaveLength(2);
  });

  it('overlapping unawaited saves are serialized: one parseable file, the last one wins, no temp files left', async () => {
    const store = new SessionStore(dir, 0);
    const saves = Array.from({ length: 12 }, (_, i) =>
      store.save(summary('race', { turnCount: i + 1, turns: Array.from({ length: i + 1 }, (_, t) => ({ turnId: t + 1, at: t, legs: [], costUsd: 0, costInr: 0, unpriced: [] })) })),
    );
    await Promise.all(saves);
    expect(await files()).toEqual(['race.json']);
    const back = await store.get('race');
    expect(back?.turnCount).toBe(12);
    expect(back?.turns).toHaveLength(12);
  });

  it('a failing save does not block the next one', async () => {
    const store = new SessionStore(dir, 0);
    const bad = store.save(summary('../escape'));
    const good = store.save(summary('ok'));
    await expect(bad).rejects.toThrow('Refusing to write a record with an unsafe id: ../escape');
    await expect(good).resolves.toBeUndefined();
    expect(await files()).toEqual(['ok.json']);
  });

  it('a failed write leaves no temp file behind', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('x'));
    // A directory squatting on the target name makes rename fail.
    await mkdir(join(dir, 'blocked.json'));
    await expect(store.save(summary('blocked'))).rejects.toThrow();
    expect((await files()).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('get() of a record that does not exist is undefined, and quietly so', async () => {
    const store = new SessionStore(dir, 0);
    expect(await store.get('never-written')).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('get() of a corrupt record is undefined, and says so', async () => {
    const store = new SessionStore(dir, 0);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'broken.json'), '{"recordId": "broken", "turns": [', 'utf8');
    expect(await store.get('broken')).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('[store] broken.json could not be read:', expect.any(String));
  });
});

describe('SessionStore — ids are validated on every path', () => {
  const UNSAFE = [
    '', '..', '.', '../x', '../../etc/passwd', 'a/b', 'a\\b', '/abs', 'a.b', 'a b', 'a\0b', '%2e%2e', 'rec.json', 'x'.repeat(121), 'ü',
  ];

  it.each(UNSAFE)('get(%j) is refused without touching the filesystem', async (id) => {
    const store = new SessionStore(dir, 0);
    expect(await store.get(id)).toBeUndefined();
    expect(existsSync(dir)).toBe(false); // init() never ran
  });

  it('get() cannot reach a real, valid record outside the directory', async () => {
    await writeFile(join(base, 'outside.json'), JSON.stringify(summary('outside')), 'utf8');
    const store = new SessionStore(dir, 0);
    expect(await store.get('../outside')).toBeUndefined();
  });

  it.each(UNSAFE)('save() of a record with id %j is refused and writes nothing', async (id) => {
    const store = new SessionStore(dir, 0);
    await expect(store.save(summary(id))).rejects.toThrow(/unsafe id/);
    expect(existsSync(dir)).toBe(false);
  });

  it.each(UNSAFE)('audioPath(%j) throws synchronously', (id) => {
    const store = new SessionStore(dir, 0);
    expect(() => store.audioPath(id)).toThrow(`Unsafe record id: ${id}`);
  });

  it('accepts the full allowed alphabet up to 120 characters', async () => {
    const store = new SessionStore(dir, 0);
    const id = `AZaz09_-${'x'.repeat(112)}`;
    expect(id).toHaveLength(120);
    await store.save(summary(id));
    expect((await store.get(id))?.recordId).toBe(id);
    expect(store.audioPath(id)).toBe(join(resolve(dir), `${id}.wav`));
  });

  it("accepts a ledger's generated record id", () => {
    const ledger = new UsageLedger('s', 'pipeline', 'l', CONFIG);
    const store = new SessionStore(dir, 0);
    expect(() => store.audioPath(ledger.recordId)).not.toThrow();
  });
});

describe('SessionStore.audioPath', () => {
  it('sits beside the JSON, whether or not the file exists', () => {
    const store = new SessionStore(dir, 0);
    expect(store.audioPath('rec-1')).toBe(join(dir, 'rec-1.wav'));
    expect(existsSync(store.audioPath('rec-1'))).toBe(false);
  });

  it('resolves a relative directory against the working directory', () => {
    const store = new SessionStore('relative/sessions', 0);
    expect(store.audioPath('r')).toBe(join(process.cwd(), 'relative', 'sessions', 'r.wav'));
  });

  it('the process singleton lives in SESSION_DIR', () => {
    expect(sessionStore.audioPath('abc')).toBe(join(resolve(process.env.SESSION_DIR!), 'abc.wav'));
  });
});

describe('SessionStore.list — the index', () => {
  it('an empty directory lists nothing', async () => {
    await mkdir(dir);
    expect(await new SessionStore(dir, 0).list()).toEqual([]);
  });

  it('a directory that does not exist yet is created and lists nothing', async () => {
    expect(await new SessionStore(dir, 0).list()).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('orders records newest first by startedAt, not by write order or name', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('b-middle', { startedAt: 2_000 }));
    await store.save(summary('c-oldest', { startedAt: 1_000 }));
    await store.save(summary('a-newest', { startedAt: 3_000 }));
    expect((await store.list()).map((e) => e.recordId)).toEqual(['a-newest', 'b-middle', 'c-oldest']);
  });

  it('carries the index fields, the config minus its prompt, and a SHA-256 of the prompt', async () => {
    const store = new SessionStore(dir, 0);
    const s = summary('rec', { totals: [ttsTotal(1.25), ttsTotal(2.5)], unpriced: ['deepgram-tts:aura'] });
    await store.save(s);
    const [row] = await store.list();
    const { systemPrompt: _p, ...configWithoutPrompt } = CONFIG;
    expect(row).toEqual({
      recordId: 'rec',
      label: 'label rec',
      mode: 'pipeline',
      startedAt: 1_000,
      endedAt: 6_000,
      turnCount: 1,
      costUsd: 0.0213,
      costInr: 2.0141,
      unpriced: ['deepgram-tts:aura'],
      config: configWithoutPrompt,
      promptSha256: BE_BRIEF_SHA256,
      durationMs: 5_000,
      speechSeconds: 3.75,
      latency: { ttfaMedianMs: 500 },
    });
    expect(JSON.stringify(row)).not.toContain('Be brief.');
  });

  it('a record with no reported audio has no speech time — undefined, not zero', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('quiet', { totals: [ttsTotal()] }));
    expect((await store.list())[0].speechSeconds).toBeUndefined();
  });

  it('reads back a legacy record that predates costInr / unpriced / config', async () => {
    await mkdir(dir);
    const legacy: Record<string, unknown> = { ...summary('legacy') };
    delete legacy.costInr;
    delete legacy.unpriced;
    delete legacy.config;
    delete legacy.totals;
    await writeFile(join(dir, 'legacy.json'), JSON.stringify(legacy), 'utf8');
    const [row] = await new SessionStore(dir, 0).list();
    expect(row.recordId).toBe('legacy');
    expect(row.costInr).toBe(0);
    expect(row.unpriced).toEqual([]);
    expect(row.config).toBeUndefined();
    expect(row.promptSha256).toBeUndefined();
    expect(row.speechSeconds).toBeUndefined();
  });

  it('a non-string system prompt gets no fingerprint', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('np', { config: { ...CONFIG, systemPrompt: 42 as unknown as string } }));
    expect((await store.list())[0].promptSha256).toBeUndefined();
  });

  it('skips a corrupt file, says so out loud, and still lists the rest', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('good', { startedAt: 2_000 }));
    await writeFile(join(dir, 'garbage.json'), '{not json', 'utf8');
    await writeFile(join(dir, 'null.json'), 'null', 'utf8');
    await writeFile(join(dir, 'empty.json'), '', 'utf8');
    const list = await store.list();
    expect(list.map((e) => e.recordId)).toEqual(['good']);
    const messages = errorSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    for (const f of ['garbage.json', 'null.json', 'empty.json']) {
      expect(messages).toContain(`[store] skipping unreadable record ${f}:`);
    }
  });

  it('ignores everything that is not a .json record', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('only'));
    await writeFile(join(dir, 'only.wav'), 'RIFF', 'utf8');
    await writeFile(join(dir, 'notes.txt'), 'x', 'utf8');
    await writeFile(join(dir, 'other.json.abcd1234.tmp'), '{', 'utf8');
    await mkdir(join(dir, 'subdir'));
    expect((await store.list()).map((e) => e.recordId)).toEqual(['only']);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reuses a parsed entry until the file mtime or size moves', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('cached'));
    const path = join(dir, 'cached.json');
    // Pin a whole-second mtime first: one read back from stat() carries
    // sub-millisecond precision that utimes() cannot restore exactly.
    const atime = new Date('2026-10-01T00:00:00Z');
    const mtime = new Date('2026-10-01T00:00:00Z');
    await utimes(path, atime, mtime);
    const first = await store.list();
    const { size } = await stat(path);
    // Same length, same mtime, different (corrupt) bytes: a re-parse would skip it.
    await writeFile(path, 'x'.repeat(size), 'utf8');
    await utimes(path, atime, mtime);
    const second = await store.list();
    expect(second).toEqual(first);
    expect(errorSpy).not.toHaveBeenCalled();
    // Once the mtime moves, the file is re-read — and now it is skipped.
    await utimes(path, atime, new Date(mtime.getTime() + 5_000));
    expect(await store.list()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('drops a record that was deleted from under it', async () => {
    const store = new SessionStore(dir, 0);
    await store.save(summary('a', { startedAt: 1 }));
    await store.save(summary('b', { startedAt: 2 }));
    expect(await store.list()).toHaveLength(2);
    await rm(join(dir, 'a.json'));
    expect((await store.list()).map((e) => e.recordId)).toEqual(['b']);
  });

  it('sees a record written by another process', async () => {
    const store = new SessionStore(dir, 0);
    expect(await store.list()).toEqual([]);
    await writeFile(join(dir, 'ext.json'), JSON.stringify(summary('ext')), 'utf8');
    expect((await store.list()).map((e) => e.recordId)).toEqual(['ext']);
  });
});

describe('SessionStore — a broken directory never poisons the store', () => {
  it('list() of an unusable directory returns [] and reports it', async () => {
    await writeFile(dir, 'i am a file, not a directory', 'utf8');
    expect(await new SessionStore(dir, 0).list()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith('[store] cannot list records:', expect.any(String));
  });

  it('a failed mkdir is not cached: once the cause is fixed, the same store works', async () => {
    await writeFile(dir, 'squatter', 'utf8');
    const store = new SessionStore(dir, 0);
    await expect(store.save(summary('r'))).rejects.toThrow();
    await rm(dir);
    await store.save(summary('r'));
    expect((await store.get('r'))?.recordId).toBe('r');
  });
});

describe('SessionStore — stale temp files are swept once, at startup', () => {
  it('removes .tmp files older than an hour and keeps everything else', async () => {
    await mkdir(dir);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const write = async (name: string, when: Date) => {
      await writeFile(join(dir, name), 'x', 'utf8');
      await utimes(join(dir, name), when, when);
    };
    await write('old.json.deadbeef.tmp', twoHoursAgo);
    await write('rec.left.pcm.tmp', twoHoursAgo);
    await write('inflight.tmp', tenMinutesAgo);
    await write('old.wav', twoHoursAgo);
    await write('old.json', twoHoursAgo);

    const store = new SessionStore(dir, 0);
    await store.get('anything');
    expect(await files()).toEqual(['inflight.tmp', 'old.json', 'old.wav']);

    // Only once: a stale temp appearing later is left for the next startup.
    await write('later.tmp', twoHoursAgo);
    await store.list();
    expect(await files()).toContain('later.tmp');
  });
});

describe('SessionStore — SESSION_MAX_RECORDS pruning', () => {
  const touchWav = (id: string) => writeFile(join(dir, `${id}.wav`), 'RIFF', 'utf8');

  it('is off by default: records are kept forever', async () => {
    vi.stubEnv('SESSION_MAX_RECORDS', undefined);
    const store = new SessionStore(dir);
    for (let i = 0; i < 5; i++) await store.save(summary(`r${i}`, { startedAt: i }));
    expect(await store.list()).toHaveLength(5);
  });

  it('deletes the oldest records beyond the cap, JSON and recording both', async () => {
    const store = new SessionStore(dir, 2);
    await store.save(summary('r1', { startedAt: 1_000 }));
    await touchWav('r1');
    await store.save(summary('r2', { startedAt: 2_000 }));
    await touchWav('r2');
    expect(await files()).toEqual(['r1.json', 'r1.wav', 'r2.json', 'r2.wav']);
    await store.save(summary('r3', { startedAt: 3_000 }));
    expect(await files()).toEqual(['r2.json', 'r2.wav', 'r3.json']);
    expect((await store.list()).map((e) => e.recordId)).toEqual(['r3', 'r2']);
  });

  it('prunes by startedAt, not by write order — saving an old record past the cap drops it', async () => {
    const store = new SessionStore(dir, 2);
    await store.save(summary('new', { startedAt: 3_000 }));
    await store.save(summary('mid', { startedAt: 2_000 }));
    await store.save(summary('ancient', { startedAt: 1_000 }));
    expect(await files()).toEqual(['mid.json', 'new.json']);
  });

  it('rewriting an existing record does not count against the cap', async () => {
    const store = new SessionStore(dir, 2);
    await store.save(summary('a', { startedAt: 1 }));
    await store.save(summary('b', { startedAt: 2 }));
    await store.save(summary('a', { startedAt: 1, turnCount: 2 }));
    await store.save(summary('b', { startedAt: 2, turnCount: 2 }));
    expect(await files()).toEqual(['a.json', 'b.json']);
  });

  it.each([
    ['2', 2],
    ['2.9', 2],
    ['1', 1],
  ])('SESSION_MAX_RECORDS=%j caps at %i', async (raw, cap) => {
    vi.stubEnv('SESSION_MAX_RECORDS', raw);
    const store = new SessionStore(dir);
    for (let i = 0; i < 4; i++) await store.save(summary(`r${i}`, { startedAt: i }));
    expect(await store.list()).toHaveLength(cap);
  });

  it.each(['0', '-3', 'abc', '', 'Infinity', 'NaN'])('SESSION_MAX_RECORDS=%j disables pruning', async (raw) => {
    vi.stubEnv('SESSION_MAX_RECORDS', raw);
    const store = new SessionStore(dir);
    for (let i = 0; i < 4; i++) await store.save(summary(`r${i}`, { startedAt: i }));
    expect(await store.list()).toHaveLength(4);
  });

  it('an explicit constructor cap wins over the environment', async () => {
    vi.stubEnv('SESSION_MAX_RECORDS', '1');
    const store = new SessionStore(dir, 3);
    for (let i = 0; i < 4; i++) await store.save(summary(`r${i}`, { startedAt: i }));
    expect(await store.list()).toHaveLength(3);
  });

  it('a stale record with an id this store will not touch does not break saving or stop pruning', async () => {
    await mkdir(dir);
    // A '.' makes the id unsafe for audioPath(), which throws synchronously.
    await writeFile(join(dir, 'bad.name.json'), JSON.stringify(summary('bad.name', { startedAt: 1 })), 'utf8');
    const store = new SessionStore(dir, 1);
    await expect(store.save(summary('good', { startedAt: 5 }))).resolves.toBeUndefined();
    expect(await files()).toEqual(['good.json']);
    await expect(store.save(summary('newer', { startedAt: 6 }))).resolves.toBeUndefined();
    expect(await files()).toEqual(['newer.json']);
  });

  it('a missing recording is not an error', async () => {
    const store = new SessionStore(dir, 1);
    await store.save(summary('a', { startedAt: 1 }));
    await expect(store.save(summary('b', { startedAt: 2 }))).resolves.toBeUndefined();
    expect(await files()).toEqual(['b.json']);
  });

  /*
   * Was a bug: prune() unlinked the path built from the recordId in the file's
   * CONTENTS, unvalidated, so `"recordId": "../victim"` deleted
   * `<SESSION_DIR>/../victim.json`. Pruning now works from the filename it read
   * from the directory, and `path()` refuses any id the store would not generate.
   */
  it('pruning never deletes a file outside the store directory', async () => {
    await mkdir(dir);
    const victim = join(base, 'victim.json');
    await writeFile(victim, '{"precious":true}', 'utf8');
    await writeFile(join(dir, 'evil.json'), JSON.stringify(summary('../victim', { startedAt: 1 })), 'utf8');
    const store = new SessionStore(dir, 1);
    await store.save(summary('good', { startedAt: 5 }));
    expect(existsSync(victim)).toBe(true);
  });

  /*
   * Same root cause, same fix: a file whose name and recordId disagree used to
   * be skipped by prune (it unlinked the name derived from the contents), so the
   * cap was silently exceeded. Pruning by filename removes it.
   */
  it('a record whose filename and recordId disagree is still pruned', async () => {
    await mkdir(dir);
    await writeFile(join(dir, 'copied.json'), JSON.stringify(summary('original', { startedAt: 1 })), 'utf8');
    const store = new SessionStore(dir, 1);
    await store.save(summary('good', { startedAt: 5 }));
    expect(await files()).toEqual(['good.json']);
  });

  it('list() reports the filename as the id, so every listed record can be fetched', async () => {
    await mkdir(dir);
    await writeFile(join(dir, 'copied.json'), JSON.stringify(summary('original', { startedAt: 1 })), 'utf8');
    const store = new SessionStore(dir, 0);
    const [entry] = await store.list();
    expect(entry.recordId).toBe('copied');
    expect(await store.get(entry.recordId)).toBeDefined();
  });
});

describe('SessionStore — records hold no credentials', () => {
  it("a ledger summary on disk contains the config and the numbers, never the environment's keys", async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-ZZZ-must-not-be-persisted-000');
    vi.stubEnv('CARTESIA_API_KEY', 'cartesia-key-must-not-be-persisted');
    const ledger = new UsageLedger('sock', 'pipeline', 'label', CONFIG);
    ledger.record(1, [
      { leg: 'stt', providerId: 'sarvam-stt', modelId: 'saaras:v3', unit: 'audio_seconds', inputUnits: 3, outputUnits: 0, source: 'vendor' },
      ttsTotal(1),
    ]);
    const store = new SessionStore(dir, 0);
    await store.save(ledger.summary());
    const raw = await readFile(join(dir, `${ledger.recordId}.json`), 'utf8');
    expect(raw).not.toContain('must-not-be-persisted');
    expect(raw).not.toMatch(/API_KEY|credential|secret/i);
    // The prompt IS persisted, deliberately.
    expect(JSON.parse(raw).config.systemPrompt).toBe('Be brief.');
  });
});

describe('promptSha256', () => {
  it('matches published SHA-256 test vectors', () => {
    expect(promptSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(promptSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes exactly as sent — no trimming', () => {
    expect(promptSha256(' abc')).toBe('d92b1cb3a32147b86a4db0647e4bf6eda6cf160fd3b2da264c5b088c9f9ccbfa');
    expect(promptSha256(' abc')).not.toBe(promptSha256('abc'));
  });

  it('hashes the UTF-8 bytes', () => {
    expect(promptSha256('नमस्ते')).toBe('ddb08d77c2d511947652161b35987022711aa216387b041dd459a03eb66a8304');
    expect(promptSha256('Be brief.')).toBe(BE_BRIEF_SHA256);
  });
});

describe('speechSecondsOf', () => {
  it('sums every leg total that reported audio, to 3 dp', () => {
    expect(speechSecondsOf({ totals: [ttsTotal(1.25), ttsTotal(2.5)] })).toBe(3.75);
    expect(speechSecondsOf({ totals: [ttsTotal(0.1), ttsTotal(0.2)] })).toBe(0.3);
    expect(speechSecondsOf({ totals: [ttsTotal(1.0004), ttsTotal(1.0004)] })).toBe(2.001);
  });

  it('a genuine zero is a measurement, kept as 0', () => {
    expect(speechSecondsOf({ totals: [ttsTotal(0)] })).toBe(0);
  });

  it('no audio reported at all is undefined, not 0', () => {
    expect(speechSecondsOf({ totals: [] })).toBeUndefined();
    expect(speechSecondsOf({ totals: [ttsTotal()] })).toBeUndefined();
  });

  it('ignores negative, non-finite and non-numeric values, and holes', () => {
    const junk = [
      ttsTotal(-1),
      { ...ttsTotal(), audioSeconds: Number.NaN },
      { ...ttsTotal(), audioSeconds: Number.POSITIVE_INFINITY },
      { ...ttsTotal(), audioSeconds: '3' as unknown as number },
      null as unknown as LegUsage,
      ttsTotal(2),
    ];
    expect(speechSecondsOf({ totals: junk })).toBe(2);
  });

  it('tolerates a record whose totals is missing or not an array', () => {
    expect(speechSecondsOf({ totals: undefined as unknown as LegUsage[] })).toBeUndefined();
    expect(speechSecondsOf({ totals: {} as unknown as LegUsage[] })).toBeUndefined();
  });
});
