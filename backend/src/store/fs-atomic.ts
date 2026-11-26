import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * Writes `text` to a sibling temp file and renames it over `path`, so a reader
 * (or a crash) never sees half a file. The temp is removed if anything fails.
 * Temp names end in `.tmp`, which `SessionStore`'s startup sweep knows about.
 */
export async function writeFileAtomic(path: string, text: string, opts: { mode?: number } = {}): Promise<void> {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: opts.mode });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Runs tasks one at a time, in call order. A task that fails does not block
 * the next one; each caller sees its own result.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
}
