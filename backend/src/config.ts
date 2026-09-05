import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** Comma-separated origins allowed to talk to this server. */
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  logAudio: process.env.LOG_AUDIO === '1',
};

/** Passed to every provider so no provider reads process.env directly. */
export function credentials(): Record<string, string | undefined> {
  return { ...process.env };
}

/**
 * Strips anything that looks like one of our own secrets out of a string.
 *
 * `credentials()` hands every provider the whole environment, so a vendor
 * adapter that ever interpolates its options into an error message would send
 * every key in `.env` straight to the browser. Errors are scrubbed at the
 * boundary rather than trusting each adapter to be careful.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [key, value] of Object.entries(process.env)) {
    // Short values produce false positives (PATH fragments, "1", locale names).
    if (!value || value.length < 12) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    while (out.includes(value)) out = out.replace(value, `«${key} redacted»`);
  }
  return out;
}
