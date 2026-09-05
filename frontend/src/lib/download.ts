/**
 * Hands the browser a JSON file.
 *
 * The revoke is deferred on purpose: revoking the object URL in the same tick
 * as `click()` races the browser's fetch of it, and Firefox and Safari have
 * historically ended up saving nothing at all.
 */
export function downloadJson(data: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
