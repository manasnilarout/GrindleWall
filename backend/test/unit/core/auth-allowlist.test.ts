import { existsSync, rmSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Allowlist,
  AllowlistError,
  AllowlistUnavailableError,
  isAllowed,
  normalizeEntry,
} from '../../../src/auth-allowlist.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'allowlist-')), '.auth', 'allowlist.json');

describe('normalizeEntry', () => {
  it('takes an internationalised domain in its punycode form, TLD included', () => {
    expect(normalizeEntry('domain', 'xn--80ak6aa92e.xn--p1ai').value).toBe('xn--80ak6aa92e.xn--p1ai');
  });

  it('lower-cases, trims and strips a leading @ from domains', () => {
    expect(normalizeEntry('domain', '  @Example.COM ')).toEqual({ kind: 'domain', value: 'example.com' });
    expect(normalizeEntry('email', ' Someone@Example.com')).toEqual({ kind: 'email', value: 'someone@example.com' });
  });

  for (const [kind, value] of [
    ['domain', 'localhost'],
    ['domain', 'not a domain.com'],
    ['domain', 'someone@example.com'],
    ['domain', ''],
    ['email', 'no-at-sign'],
    ['email', 'a@b'],
    ['nope', 'example.com'],
    ['domain', 42],
  ] as const) {
    it(`rejects ${kind} ${JSON.stringify(value)}`, () => {
      expect(() => normalizeEntry(kind, value)).toThrow(AllowlistError);
    });
  }
});

describe('Allowlist', () => {
  it('allows the pinned domain out of the box, exactly — not look-alikes or subdomains', async () => {
    const list = new Allowlist(fresh(), ['magickvoice.com']);
    expect(await list.allows('intern@magickvoice.com')).toBe(true);
    expect(await list.allows('Intern@MagickVoice.COM')).toBe(true);
    expect(await list.allows('x@evil-magickvoice.com')).toBe(false);
    expect(await list.allows('x@sub.magickvoice.com')).toBe(false);
    expect(await list.allows('x@magickvoice.com.evil.io')).toBe(false);
    expect(await list.allows('someone@gmail.com')).toBe(false);
    expect(await list.allows('')).toBe(false);
  });

  it('adds domains and single addresses, persists them, and a new instance reads them back', async () => {
    const file = fresh();
    const list = new Allowlist(file, ['magickvoice.com']);
    await list.add('domain', 'partner.io', 'admin@magickvoice.com');
    const entries = await list.add('email', 'Intern.Friend@gmail.com', 'admin@magickvoice.com');
    expect(entries.map((e) => [e.kind, e.value, e.source])).toEqual([
      ['domain', 'magickvoice.com', 'env'],
      ['domain', 'partner.io', 'admin'],
      ['email', 'intern.friend@gmail.com', 'admin'],
    ]);
    expect(entries[1].addedBy).toBe('admin@magickvoice.com');

    const reread = new Allowlist(file, ['magickvoice.com']);
    expect(await reread.allows('a@partner.io')).toBe(true);
    expect(await reread.allows('intern.friend@gmail.com')).toBe(true);
    expect(await reread.allows('other@gmail.com')).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).entries).toHaveLength(2);
  });

  it('a duplicate add, or one the pinned list covers, writes nothing', async () => {
    const file = fresh();
    const list = new Allowlist(file, ['magickvoice.com']);
    await list.add('domain', 'magickvoice.com', 'a');
    expect(existsSync(file)).toBe(false);
    await list.add('domain', 'partner.io', 'a');
    await list.add('domain', 'PARTNER.io', 'a');
    expect((await list.list()).filter((e) => e.value === 'partner.io')).toHaveLength(1);
  });

  it('removes admin entries but refuses to remove a pinned domain', async () => {
    const list = new Allowlist(fresh(), ['magickvoice.com']);
    await list.add('domain', 'partner.io', 'a');
    await list.remove('domain', 'partner.io');
    expect(await list.allows('a@partner.io')).toBe(false);
    await expect(list.remove('domain', 'magickvoice.com')).rejects.toThrow(/pinned/);
    expect(await list.allows('a@magickvoice.com')).toBe(true);
  });

  it('concurrent adds do not lose an entry', async () => {
    const file = fresh();
    const list = new Allowlist(file, []);
    await Promise.all(['a.io', 'b.io', 'c.io', 'd.io'].map((d) => list.add('domain', d, 'x')));
    const reread = new Allowlist(file, []);
    expect((await reread.list()).map((e) => e.value).sort()).toEqual(['a.io', 'b.io', 'c.io', 'd.io']);
  });

  it('a corrupt file fails closed to the pinned domains, and junk entries are skipped', async () => {
    const file = fresh();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{not json');
    const broken = new Allowlist(file, ['magickvoice.com']);
    expect(await broken.allows('a@magickvoice.com')).toBe(true);
    expect((await broken.list()).length).toBe(1);

    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ kind: 'domain', value: 'ok.io' }, { kind: 'domain', value: '!!' }, null] }));
    const partial = new Allowlist(file, []);
    expect((await partial.list()).map((e) => e.value)).toEqual(['ok.io']);
  });

  it('a corrupt file is never overwritten: edits are refused until it is fixed, then work', async () => {
    const file = fresh();
    mkdirSync(join(file, '..'), { recursive: true });
    const corrupt = '{"version":1,"entries":[{"kind":"domain","value":"partner.io"},]}';
    writeFileSync(file, corrupt);
    const list = new Allowlist(file, ['magickvoice.com']);
    await expect(list.add('domain', 'new.io', 'a')).rejects.toBeInstanceOf(AllowlistUnavailableError);
    await expect(list.remove('domain', 'partner.io')).rejects.toBeInstanceOf(AllowlistUnavailableError);
    expect(readFileSync(file, 'utf8')).toBe(corrupt);

    // Not cached as "empty": once someone fixes the file, the same instance reads it.
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ kind: 'domain', value: 'partner.io' }] }));
    await list.add('domain', 'new.io', 'a');
    expect((await list.list()).map((e) => e.value)).toEqual(['magickvoice.com', 'partner.io', 'new.io']);
  });

  it('concurrent first calls share one read — an add racing a sign-in is not lost', async () => {
    for (let i = 0; i < 50; i++) {
      const file = fresh();
      const list = new Allowlist(file, []);
      await Promise.all([list.allows('x@y.io'), list.add('domain', 'race.io', 'a'), list.list()]);
      expect(await list.allows('a@race.io')).toBe(true);
      expect(await new Allowlist(file, []).allows('a@race.io')).toBe(true);
    }
  });

  it('a failed save changes nothing in memory and leaves no temp file behind', async () => {
    const file = fresh();
    const list = new Allowlist(file, []);
    await list.add('domain', 'kept.io', 'a');
    // A directory where the file goes: rename() onto it fails even for root.
    rmSync(file);
    mkdirSync(file);
    await expect(list.add('domain', 'lost.io', 'a')).rejects.toThrow();
    await expect(list.remove('domain', 'kept.io')).rejects.toThrow();
    expect(await list.allows('a@lost.io')).toBe(false);
    expect(await list.allows('a@kept.io')).toBe(true);
    expect(readdirSync(join(file, '..'))).toEqual(['allowlist.json']);
  });

  it('writes the file readable by its owner only', async () => {
    const file = fresh();
    await new Allowlist(file, []).add('domain', 'a.io', 'x');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('with no pinned domains, nobody is allowed until an admin adds someone', async () => {
    const list = new Allowlist(fresh(), []);
    expect(await list.allows('a@magickvoice.com')).toBe(false);
  });
});

describe('isAllowed', () => {
  it('matches domain and exact-address entries from a snapshot', () => {
    const entries = [
      { kind: 'domain' as const, value: 'magickvoice.com', source: 'env' as const },
      { kind: 'email' as const, value: 'x@gmail.com', source: 'admin' as const },
    ];
    expect(isAllowed(entries, 'y@magickvoice.com')).toBe(true);
    expect(isAllowed(entries, 'X@gmail.com')).toBe(true);
    expect(isAllowed(entries, 'y@gmail.com')).toBe(false);
  });
});
