import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SessionIndexEntry, SessionSummary } from '../shared/protocol.js';
import { config } from '../config.js';

/**
 * Conversations are persisted as one JSON file each, rewritten after every turn
 * so a session that is never explicitly ended — a closed tab, a crash — still
 * leaves its per-turn token counts on disk.
 *
 * Flat files rather than a database: the whole point of this bench is that a
 * run can be diffed, committed, or handed to someone else.
 *
 * Two properties the naive version did not have, both of which cost real data:
 *
 *   Serialized. Callers fire save() without awaiting it, and a turn ending as
 *   the socket closes issues two saves of the same record in the same tick.
 *   Overlapping writes to one path interleave and produce a file that does not
 *   parse.
 *
 *   Atomic. The record is written to a temp file and renamed into place, so a
 *   reader — or a crash — never sees a half-written file.
 */
export class SessionStore {
  private readonly dir: string;
  private ready?: Promise<void>;
  /** Serializes every write; see the class comment. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Listing used to fully parse every record to read eight fields from each —
   * tens of megabytes on the event loop once a few hundred conversations
   * accumulate. Parsed entries are kept and reused until the file's mtime moves.
   */
  private index = new Map<string, { mtimeMs: number; size: number; entry: SessionIndexEntry }>();

  /**
   * Records are kept forever by default — this is a bench, and a run you cannot
   * go back to is worth little. `SESSION_MAX_RECORDS` opts into pruning the
   * oldest beyond a cap; it is off by default because silently deleting a
   * measurement someone is mid-comparison on is worse than disk use.
   */
  private readonly maxRecords: number;

  constructor(dir = config.sessionDir, maxRecords = Number(process.env.SESSION_MAX_RECORDS ?? 0)) {
    this.dir = resolve(dir);
    this.maxRecords = Number.isFinite(maxRecords) && maxRecords > 0 ? Math.floor(maxRecords) : 0;
  }

  /** Deletes the oldest records beyond the cap. No-op unless a cap is set. */
  private async prune(): Promise<void> {
    if (this.maxRecords <= 0) return;
    const entries = await this.list();
    for (const stale of entries.slice(this.maxRecords)) {
      await unlink(this.path(stale.recordId)).catch(() => {});
      /*
       * The recording is part of the record. Pruning the JSON and leaving the
       * WAV would quietly turn the cap into a no-op — audio is ~5.8 MB/minute
       * and the JSON is ~1-3 KB per turn, so the audio IS the disk use.
       *
       * try/catch, not `.catch()`: `audioPath` validates the id and throws
       * SYNCHRONOUSLY, before `unlink` is ever called, so a trailing `.catch`
       * never sees it. One malformed filename on disk would escape `prune`,
       * escape `writeAtomic`, and make every later `save()` report
       * "Conversation was not saved" about a record that had in fact been
       * saved — while SESSION_MAX_RECORDS silently stopped pruning for good.
       */
      try {
        await unlink(this.audioPath(stale.recordId));
      } catch {
        /* no recording, or an id this store will not touch */
      }
      this.index.delete(`${stale.recordId}.json`);
    }
  }

  private init(): Promise<void> {
    // A rejected promise must not be cached: one failed mkdir (read-only volume,
    // SESSION_DIR pointing at a file) would otherwise poison the store for the
    // lifetime of the process, with no way back even once the cause is fixed.
    this.ready ??= mkdir(this.dir, { recursive: true })
      .then(() => this.sweepStaleTemp())
      .catch((err) => {
        this.ready = undefined;
        throw err;
      });
    return this.ready;
  }

  /**
   * Removes leftover `.tmp` files once, at startup.
   *
   * A recording writes two channel temp files and unlinks them when it
   * finalizes; a process killed mid-conversation leaves both at full size, and
   * nothing else ever looks at them — `list()` filters on `.json` and `prune()`
   * only unlinks records it can see. At ~5.8 MB per recorded minute that
   * accumulates in a directory nobody thinks to check.
   *
   * The age guard is not caution about our own files but about someone else's:
   * a second server sharing this directory may have a recording in flight, and
   * an hour is far longer than any finalize takes.
   */
  private async sweepStaleTemp(): Promise<void> {
    const cutoff = Date.now() - 60 * 60 * 1000;
    try {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith('.tmp'));
      for (const f of files) {
        const path = join(this.dir, f);
        const info = await stat(path).catch(() => undefined);
        if (info && info.mtimeMs < cutoff) await unlink(path).catch(() => {});
      }
    } catch {
      // A sweep that cannot run must never stop the store from working.
    }
  }

  /** Idempotent: called after every turn, and again when the conversation ends. */
  async save(summary: SessionSummary): Promise<void> {
    const run = this.queue.then(
      () => this.writeAtomic(summary),
      () => this.writeAtomic(summary), // a previous save failing must not block this one
    );
    // Keep the chain alive regardless of outcome; callers see their own result.
    this.queue = run.catch(() => {});
    return run;
  }

  private async writeAtomic(summary: SessionSummary): Promise<void> {
    // The read path validates ids because they arrive from a URL; the write path
    // validates too so the guard is not one-sided.
    if (!isSafeId(summary.recordId)) {
      throw new Error(`Refusing to write a record with an unsafe id: ${summary.recordId}`);
    }
    await this.init();
    const target = this.path(summary.recordId);
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(summary, null, 2), 'utf8');
      await rename(tmp, target);
      await this.prune();
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /**
   * Where this record's stereo recording lives, whether or not it exists —
   * callers stat it. Same id validation as the JSON path, because this one is
   * reached from a URL parameter.
   */
  audioPath(recordId: string): string {
    if (!isSafeId(recordId)) throw new Error(`Unsafe record id: ${recordId}`);
    return join(this.dir, `${recordId}.wav`);
  }

  async list(): Promise<SessionIndexEntry[]> {
    try {
      await this.init();
      const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
      const entries = await Promise.all(files.map((f) => this.readIndexEntry(f)));
      // Drop cache entries for records that have been deleted from under us.
      const live = new Set(files);
      for (const key of this.index.keys()) if (!live.has(key)) this.index.delete(key);
      return entries
        .filter((e): e is SessionIndexEntry => e !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt);
    } catch (err) {
      console.error('[store] cannot list records:', (err as Error).message);
      return [];
    }
  }

  async get(recordId: string): Promise<SessionSummary | undefined> {
    if (!isSafeId(recordId)) return undefined;
    try {
      await this.init();
      return JSON.parse(await readFile(this.path(recordId), 'utf8')) as SessionSummary;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[store] ${recordId}.json could not be read:`, (err as Error).message);
      }
      return undefined;
    }
  }

  private async readIndexEntry(file: string): Promise<SessionIndexEntry | undefined> {
    const path = join(this.dir, file);
    try {
      const { mtimeMs, size } = await stat(path);
      const cached = this.index.get(file);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.entry;

      const s = JSON.parse(await readFile(path, 'utf8')) as SessionSummary;
      const entry: SessionIndexEntry = {
        recordId: s.recordId,
        label: s.label,
        mode: s.mode,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        turnCount: s.turnCount,
        costUsd: s.costUsd,
        costInr: s.costInr ?? 0,
        unpriced: s.unpriced ?? [],
      };
      this.index.set(file, { mtimeMs, size, entry });
      return entry;
    } catch (err) {
      // Skipping keeps one damaged file from failing the whole listing, but it
      // is said out loud: a silently vanishing record looks like a lost session.
      console.error(`[store] skipping unreadable record ${file}:`, (err as Error).message);
      this.index.delete(file);
      return undefined;
    }
  }

  private path(recordId: string): string {
    return join(this.dir, `${recordId}.json`);
  }
}

/** Record ids are generated, but this is a filesystem path built from a URL parameter. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(id);
}

export const sessionStore = new SessionStore();
