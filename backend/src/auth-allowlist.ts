import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export class AllowlistError extends Error {}

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

export class Allowlist {
  private admin: FileShape['entries'] = [];
  private loaded = false;
  /** Serialises writes: two admins clicking at once must not lose an entry. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly pinnedDomains: readonly string[],
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<FileShape>;
      this.admin = [];
      for (const e of Array.isArray(parsed.entries) ? parsed.entries : []) {
        try {
          const n = normalizeEntry(e?.kind, e?.value);
          this.admin.push({ ...n, addedBy: e.addedBy, addedAt: e.addedAt });
        } catch {
          // A hand-edited junk line is skipped rather than taking the gate down.
        }
      }
    } catch (err) {
      // No file yet is the normal first boot. Anything else (bad JSON, EACCES)
      // fails CLOSED for admin additions: the pinned env domains still work.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[auth] allowlist ${this.file} unreadable, using pinned domains only:`, (err as Error).message);
      }
      this.admin = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body: FileShape = { version: 1, entries: this.admin };
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    await rename(tmp, this.file);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<AllowEntry[]> {
    await this.load();
    const pinned: AllowEntry[] = this.pinnedDomains.map((value) => ({ kind: 'domain', value, source: 'env' }));
    return [...pinned, ...this.admin.map((e) => ({ ...e, source: 'admin' as const }))];
  }

  async allows(email: string): Promise<boolean> {
    return isAllowed(await this.list(), email);
  }

  /** Adds an entry; a duplicate (or one the pinned list already covers) is a no-op. */
  add(kind: unknown, value: unknown, addedBy: string): Promise<AllowEntry[]> {
    const entry = normalizeEntry(kind, value);
    return this.serial(async () => {
      await this.load();
      const pinned = entry.kind === 'domain' && this.pinnedDomains.includes(entry.value);
      const dup = this.admin.some((e) => e.kind === entry.kind && e.value === entry.value);
      if (!pinned && !dup) {
        this.admin.push({ ...entry, addedBy, addedAt: Date.now() });
        await this.save();
      }
      return this.list();
    });
  }

  /** Removes an admin entry. Pinned env domains cannot be removed here. */
  remove(kind: unknown, value: unknown): Promise<AllowEntry[]> {
    const entry = normalizeEntry(kind, value);
    return this.serial(async () => {
      await this.load();
      if (entry.kind === 'domain' && this.pinnedDomains.includes(entry.value)) {
        throw new AllowlistError(`${entry.value} is pinned by AUTH_ALLOWED_DOMAINS and cannot be removed here`);
      }
      const before = this.admin.length;
      this.admin = this.admin.filter((e) => !(e.kind === entry.kind && e.value === entry.value));
      if (this.admin.length !== before) await this.save();
      return this.list();
    });
  }
}
