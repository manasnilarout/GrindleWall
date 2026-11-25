import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Who may sign in with Google.
 *
 * Two sources, kept apart on purpose:
 *  - `env`   — AUTH_ALLOWED_DOMAINS (default `magickvoice.com`). The pinned
 *              baseline; the Access page shows it but cannot remove it, so a
 *              mis-click cannot lock the whole company out.
 *  - `admin` — domains and single addresses an admin added, persisted to one
 *              JSON file and rewritten atomically on every change.
 *
 * A Google account is allowed if its email's domain is listed, or the full
 * address is. Matching is exact on the domain — `magickvoice.com` does not
 * admit `evil-magickvoice.com` or `sub.magickvoice.com`.
 */

export type AllowKind = 'domain' | 'email';

export interface AllowEntry {
  kind: AllowKind;
  value: string;
  source: 'env' | 'admin';
  /** Admin entries only: who added it, and when (epoch ms). */
  addedBy?: string;
  addedAt?: number;
}

interface FileShape {
  version: 1;
  entries: Array<{ kind: AllowKind; value: string; addedBy?: string; addedAt?: number }>;
}

/** ASCII hostnames; an internationalised name goes in as its punycode (`xn--…`), TLD included. */
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** The request was bad (junk value, pinned domain): a 400. */
export class AllowlistError extends Error {}
/** The file on disk cannot be read, so it must not be written either: a 503. */
export class AllowlistUnavailableError extends Error {}

/** Lower-cases and validates; throws `AllowlistError` on junk. */
export function normalizeEntry(kind: unknown, raw: unknown): { kind: AllowKind; value: string } {
  if (kind !== 'domain' && kind !== 'email') throw new AllowlistError('kind must be "domain" or "email"');
  if (typeof raw !== 'string') throw new AllowlistError('value must be a string');
  let value = raw.trim().toLowerCase();
  if (kind === 'domain') {
    value = value.replace(/^@/, '');
    if (!DOMAIN_RE.test(value)) throw new AllowlistError(`"${raw}" is not a domain (e.g. example.com)`);
  } else {
    if (!EMAIL_RE.test(value)) throw new AllowlistError(`"${raw}" is not an email address`);
    const domain = value.slice(value.lastIndexOf('@') + 1);
    if (!DOMAIN_RE.test(domain)) throw new AllowlistError(`"${raw}" is not an email address`);
  }
  return { kind, value };
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** Pure check against a snapshot from `list()`. */
export function isAllowed(entries: readonly AllowEntry[], email: string): boolean {
  const addr = email.trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return false;
  const domain = domainOf(addr);
  return entries.some((e) => (e.kind === 'domain' ? e.value === domain : e.value === addr));
}

type StoredEntry = FileShape['entries'][number];

interface Loaded {
  entries: StoredEntry[];
  /** False when the file exists but could not be read: writing would overwrite what is in it. */
  writable: boolean;
  problem?: string;
}

export class Allowlist {
  /** Set once the file has been read (or found absent). An unreadable file is never cached: the next call retries. */
  private state: { entries: StoredEntry[] } | undefined;
  /** One read in flight at a time — concurrent first calls share it instead of racing to assign. */
  private loading: Promise<Loaded> | undefined;
  /** Serialises writes: two admins clicking at once must not lose an entry. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly pinnedDomains: readonly string[],
  ) {}

  private load(): Promise<Loaded> {
    if (this.state) return Promise.resolve({ entries: this.state.entries, writable: true });
    this.loading ??= this.read()
      .then((loaded) => {
        if (loaded.writable) this.state = { entries: loaded.entries };
        return loaded;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  private async read(): Promise<Loaded> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      // No file yet is the normal first boot.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], writable: true };
      return this.unreadable((err as Error).message);
    }
    let parsed: Partial<FileShape>;
    try {
      parsed = JSON.parse(text) as Partial<FileShape>;
    } catch (err) {
      return this.unreadable((err as Error).message);
    }
    const entries: StoredEntry[] = [];
    for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
      try {
        const n = normalizeEntry(e?.kind, e?.value);
        entries.push({ ...n, addedBy: e.addedBy, addedAt: e.addedAt });
      } catch {
        // A hand-edited junk line is skipped rather than taking the gate down.
      }
    }
    return { entries, writable: true };
  }

  /**
   * Fails CLOSED: sign-in falls back to the pinned domains, and every write is
   * refused — saving would replace the file's real contents with an empty list.
   */
  private unreadable(reason: string): Loaded {
    const problem = `allowlist ${this.file} is unreadable (${reason}); fix or remove it`;
    console.error(`[auth] ${problem} — using pinned domains only, edits refused`);
    return { entries: [], writable: false, problem };
  }

  private async save(entries: StoredEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const body: FileShape = { version: 1, entries };
    try {
      // 0600: it lists colleagues' addresses.
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.file);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /** Runs a mutation against the loaded entries; memory changes only once the file is written. */
  private mutate(fn: (entries: StoredEntry[]) => StoredEntry[] | undefined): Promise<AllowEntry[]> {
    return this.serial(async () => {
      const loaded = await this.load();
      if (!loaded.writable || !this.state) throw new AllowlistUnavailableError(loaded.problem ?? 'allowlist unavailable');
      const next = fn(this.state.entries);
      if (next) {
        await this.save(next);
        this.state = { entries: next };
      }
      return this.list();
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<AllowEntry[]> {
    const { entries } = await this.load();
    const pinned: AllowEntry[] = this.pinnedDomains.map((value) => ({ kind: 'domain', value, source: 'env' }));
    return [...pinned, ...entries.map((e) => ({ ...e, source: 'admin' as const }))];
  }

  async allows(email: string): Promise<boolean> {
    return isAllowed(await this.list(), email);
  }

  /** Adds an entry; a duplicate (or one the pinned list already covers) is a no-op. */
  add(kind: unknown, value: unknown, addedBy: string): Promise<AllowEntry[]> {
    const entry = normalizeEntry(kind, value);
    return this.mutate((entries) => {
      const pinned = entry.kind === 'domain' && this.pinnedDomains.includes(entry.value);
      const dup = entries.some((e) => e.kind === entry.kind && e.value === entry.value);
      return pinned || dup ? undefined : [...entries, { ...entry, addedBy, addedAt: Date.now() }];
    });
  }

  /** Removes an admin entry. Pinned env domains cannot be removed here. */
  remove(kind: unknown, value: unknown): Promise<AllowEntry[]> {
    const entry = normalizeEntry(kind, value);
    if (entry.kind === 'domain' && this.pinnedDomains.includes(entry.value)) {
      return Promise.reject(
        new AllowlistError(`${entry.value} is pinned by AUTH_ALLOWED_DOMAINS and cannot be removed here`),
      );
    }
    return this.mutate((entries) => {
      const next = entries.filter((e) => !(e.kind === entry.kind && e.value === entry.value));
      return next.length === entries.length ? undefined : next;
    });
  }
}
