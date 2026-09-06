import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /**
   * Bind address. Unset locally so Node keeps its dual-stack default. Containers
   * set `HOST=0.0.0.0` so the published port and compose DNS can reach it.
   */
  host: process.env.HOST || undefined,
  /** Comma-separated origins allowed to talk to this server. */
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  logAudio: process.env.LOG_AUDIO === '1',
  /**
   * Conversations are recorded to a stereo WAV beside their JSON record. On by
   * default — the bench exists to compare audio QUALITY, and until now nothing
   * here could be listened back to. `SESSION_AUDIO=0` turns it off; stereo
   * PCM16 @ 24 kHz costs ~5.8 MB per recorded minute.
   */
  recordAudio: process.env.SESSION_AUDIO !== '0',
  /**
   * Where records and their recordings live. Owned here so the WAV and the JSON
   * cannot end up in different directories: the audio route resolves a file
   * through `SessionStore`, so a recorder that resolved its own would 404 on a
   * file that plainly exists.
   */
  sessionDir: process.env.SESSION_DIR ?? 'data/sessions',
  /**
   * When set, Express serves a built frontend from this directory and falls
   * back to index.html for the SPA. Used by the all-in-one container image so
   * one process can own HTTP, WebSocket, and the UI. Unset in local `npm run
   * dev` — Vite serves the UI there.
   */
  staticDir: process.env.STATIC_DIR || undefined,
  /**
   * Cap on one recording, in minutes. Sanitised HERE rather than at each use so
   * there is one answer: a junk value used to cap the recorder at the default
   * while the warning shown to the user quoted the junk back verbatim.
   */
  recordAudioMaxMinutes: sanePositive(process.env.SESSION_AUDIO_MAX_MINUTES, 60),
};

function sanePositive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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
