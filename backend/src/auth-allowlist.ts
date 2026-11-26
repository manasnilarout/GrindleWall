import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HttpError } from './http-error.js';
import { SerialQueue, writeFileAtomic } from './store/fs-atomic.js';

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

/** What an admin names when adding or removing: a domain or one address. */
export interface AllowTarget {
  kind: AllowKind;
  value: string;
}

export interface AllowEntry extends AllowTarget {
  source: 'env' | 'admin';
  /** Admin entries only: who added it, and when (epoch ms). */
  addedBy?: string;
  addedAt?: number;
}

type StoredEntry = Omit<AllowEntry, 'source'>;

interface FileShape {
  version: 1;
  entries: StoredEntry[];
}

/** ASCII hostnames; an internationalised name goes in as its punycode (`xn--…`), TLD included. */
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/** The request was bad (junk value, pinned domain). */
export class AllowlistError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}
/** The file on disk cannot be read, so it must not be written either. */
export class AllowlistUnavailableError extends HttpError {
  constructor(message: string) {
    super(503, message);
  }
}

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1);
const same = (a: AllowTarget, b: AllowTarget): boolean => a.kind === b.kind && a.value === b.value;

/** Lower-cases and validates; throws `AllowlistError` on junk. */
export function normalizeEntry(kind: unknown, raw: unknown): AllowTarget {
  if (kind !== 'domain' && kind !== 'email') throw new AllowlistError('kind must be "domain" or "email"');
  if (typeof raw !== 'string') throw new AllowlistError('value must be a string');
  let value = raw.trim().toLowerCase();
  if (kind === 'domain') {
    value = value.replace(/^@/, '');
    if (!DOMAIN_RE.test(value)) throw new AllowlistError(`"${raw}" is not a domain (e.g. example.com)`);
  } else if (!EMAIL_RE.test(value) || !DOMAIN_RE.test(domainOf(value))) {
    throw new AllowlistError(`"${raw}" is not an email address`);
  }
  return { kind, value };
}

/** Pure check against a snapshot from `list()`. */
export function isAllowed(entries: readonly AllowEntry[], email: string): boolean {
  const addr = email.trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) return false;
  const domain = domainOf(addr);
  return entries.some((e) => (e.kind === 'domain' ? e.value === domain : e.value === addr));
}

interface Loaded {
  entries: StoredEntry[];
  /** Set when the file exists but could not be read: writing would overwrite what is in it. */
  problem?: string;
}

export class Allowlist {
  /** The pinned domains that survived validation; junk is dropped with an error at construction. */
  readonly pinned: readonly string[];
  /** Set once the file has been read (or found absent). An unreadable file is never cached: the next call retries. */
  private entries: StoredEntry[] | undefined;
  /** One read in flight at a time — concurrent first calls share it instead of racing to assign. */
  private loading: Promise<Loaded> | undefined;
  /** Serialises writes: two admins clicking at once must not lose an entry. */
  private readonly writes = new SerialQueue();

  constructor(
    private readonly file: string,
    pinnedDomains: readonly string[],
  ) {
    // A junk value admits nobody, so it is dropped loudly rather than kept quietly.
    this.pinned = pinnedDomains.flatMap((raw) => {
      try {
        return [normalizeEntry('domain', raw).value];
      } catch {
        console.error(`[auth] AUTH_ALLOWED_DOMAINS: "${raw}" is not a domain (e.g. magickvoice.com) — ignored`);
        return [];
      }
    });
  }

  private isPinned(t: AllowTarget): boolean {
    return t.kind === 'domain' && this.pinned.includes(t.value);
  }

  private load(): Promise<Loaded> {
    if (this.entries) return Promise.resolve({ entries: this.entries });
    this.loading ??= this.read()
      .then((loaded) => {
        if (!loaded.problem) this.entries = loaded.entries;
        return loaded;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  private async read(): Promise<Loaded> {
    let parsed: Partial<FileShape>;
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<FileShape>;
    } catch (err) {
      // No file yet is the normal first boot.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
      // Fails CLOSED: sign-in falls back to the pinned domains, and every write
      // is refused — saving would replace the file's real contents with nothing.
      const problem = `allowlist ${this.file} is unreadable (${(err as Error).message}); fix or remove it`;
      console.error(`[auth] ${problem} — using pinned domains only, edits refused`);
      return { entries: [], problem };
    }
    const entries: StoredEntry[] = [];
    for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
      try {
        entries.push({ ...normalizeEntry(e?.kind, e?.value), addedBy: e.addedBy, addedAt: e.addedAt });
      } catch {
        // A hand-edited junk line is skipped rather than taking the gate down.
      }
    }
    return { entries };
  }

  /** Runs a mutation against the loaded entries; memory changes only once the file is written. */
  private mutate(fn: (entries: StoredEntry[]) => StoredEntry[] | undefined): Promise<AllowEntry[]> {
    return this.writes.run(async () => {
      const { problem } = await this.load();
      if (!this.entries) throw new AllowlistUnavailableError(problem ?? 'allowlist unavailable');
      const next = fn(this.entries);
      if (next) {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const body: FileShape = { version: 1, entries: next };
        // 0600: it lists colleagues' addresses.
        await writeFileAtomic(this.file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
        this.entries = next;
      }
      return this.list();
    });
  }

  async list(): Promise<AllowEntry[]> {
    const { entries } = await this.load();
    const pinned: AllowEntry[] = this.pinned.map((value) => ({ kind: 'domain', value, source: 'env' }));
    return [...pinned, ...entries.map((e) => ({ ...e, source: 'admin' as const }))];
  }

  async allows(email: string): Promise<boolean> {
    return isAllowed(await this.list(), email);
  }

  /** Adds an entry; a duplicate (or one the pinned list already covers) is a no-op. */
  async add(kind: unknown, value: unknown, addedBy: string): Promise<AllowEntry[]> {
    const entry = normalizeEntry(kind, value);
    return this.mutate((entries) =>
      this.isPinned(entry) || entries.some((e) => same(e, entry))
        ? undefined
        : [...entries, { ...entry, addedBy, addedAt: Date.now() }],
    );
  }

  /** Removes an admin entry. Pinned env domains cannot be removed here. */
  async remove(kind: unknown, value: unknown): Promise<AllowEntry[]> {
    const entry = normalizeEntry(kind, value);
    if (this.isPinned(entry)) {
      throw new AllowlistError(`${entry.value} is pinned by AUTH_ALLOWED_DOMAINS and cannot be removed here`);
    }
    return this.mutate((entries) => {
      const next = entries.filter((e) => !same(e, entry));
      return next.length === entries.length ? undefined : next;
    });
  }
}
