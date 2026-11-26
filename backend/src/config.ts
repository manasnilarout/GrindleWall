import 'dotenv/config';
import { join } from 'node:path';

/** Where Google publishes the keys that sign Firebase ID tokens (as a JWK set; see `auth-google.ts`). */
export const FIREBASE_DEFAULT_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const sessionDir = process.env.SESSION_DIR ?? 'data/sessions';
const firebaseProjectId = (process.env.FIREBASE_PROJECT_ID ?? '').trim();

export const config = {
  /** Empty or junk (`PORT=`, `PORT=abc`) is unset, never `listen(0)`'s random port. */
  port: sanePort(process.env.PORT, 8787),
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
  sessionDir,
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
  /**
   * Naive login. Both AUTH_PASSWORD and AUTH_HMAC_SECRET must be set to turn
   * the gate on — unset, the bench stays open so smoke and render-check keep
   * working. The username is fixed in `auth.ts`, not here.
   */
  authPassword: process.env.AUTH_PASSWORD ?? '',
  /**
   * HMAC key the login page is handed so the password itself never crosses
   * the wire. Served on GET /api/auth/config; the backend recomputes the same
   * digest of `authPassword` and compares. Not encryption — HMAC is one-way.
   */
  authHmacSecret: process.env.AUTH_HMAC_SECRET ?? '',
  /**
   * How long a UI/API session lasts after a successful login. Default 3 hours.
   * Capped at 24h: `setTimeout` overflows above ~24.8 days and would fire
   * immediately on the client while the server session was still live.
   */
  authSessionTtlMs: Math.round(Math.min(sanePositive(process.env.AUTH_SESSION_HOURS, 3), 24) * 3_600_000),
  /**
   * Google sign-in through Firebase Auth. Setting FIREBASE_PROJECT_ID and
   * FIREBASE_API_KEY turns it on; the browser does the Google popup and the
   * backend verifies the Firebase ID token it gets back, then issues its own
   * session exactly as the password login does. The API key is served
   * unauthenticated on GET /api/auth/config, as Firebase web apps always ship
   * it — so it must be RESTRICTED in the Google Cloud console to the Firebase
   * Auth APIs. An unrestricted key works against every API enabled in its
   * project (Gemini, if that is the same project).
   */
  firebase: {
    projectId: firebaseProjectId,
    apiKey: (process.env.FIREBASE_API_KEY ?? '').trim(),
    authDomain:
      (process.env.FIREBASE_AUTH_DOMAIN ?? '').trim() || (firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : ''),
    appId: (process.env.FIREBASE_APP_ID ?? '').trim() || undefined,
    /**
     * Where Firebase's ID-token signing keys are fetched from. Overridable ONLY
     * so the integration tests can sign tokens with a local key — whoever serves
     * this URL can mint any identity, admins included — so `index.ts` refuses
     * to start with an override that is not http on a loopback address.
     */
    jwksUrl: (process.env.FIREBASE_JWKS_URL ?? '').trim() || FIREBASE_DEFAULT_JWKS_URL,
  },
  /**
   * Email domains whose Google accounts may sign in, comma-separated. These are
   * the pinned baseline: an admin can add more domains (and single addresses)
   * from the Access page, but cannot remove these — change the env var for that.
   * Raw values: `Allowlist` normalises them and drops any that are not a domain.
   */
  authAllowedDomains: csv(process.env.AUTH_ALLOWED_DOMAINS ?? 'magickvoice.com'),
  /**
   * Google accounts that sign in as admin (may edit the allowlist). The
   * password login is always admin. Comma-separated, case-insensitive.
   */
  authAdminEmails: csv(process.env.AUTH_ADMIN_EMAILS ?? '').map((e) => e.toLowerCase()),
  /**
   * Where admin-added domains/emails persist. Defaults to a directory inside
   * SESSION_DIR — the one path the container already keeps on a volume — and
   * deliberately not a `*.json` file at its top level, which the session store
   * would try to read as a conversation.
   */
  authAllowlistFile:
    process.env.AUTH_ALLOWLIST_FILE || join(sessionDir, '.auth', 'allowlist.json'),
};

function csv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function sanePositive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sanePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) && n > 0 && n <= 65_535 ? n : fallback;
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
  // value -> label. Login secrets go first so they keep their own label when an
  // env var holds the same value.
  const secrets = new Map<string, string>();
  // Human passwords and HMAC keys are often shorter than the floor below.
  // Always scrub the ones we actually use for the login gate.
  for (const [key, value] of [
    ['AUTH_PASSWORD', config.authPassword],
    ['AUTH_HMAC_SECRET', config.authHmacSecret],
  ] as const) {
    if (value && !secrets.has(value)) secrets.set(value, key);
  }
  for (const [key, value] of Object.entries(process.env)) {
    // Served to every visitor on GET /api/auth/config anyway, so redacting it
    // from an error would hide nothing.
    if (key === 'FIREBASE_API_KEY') continue;
    // Short values produce false positives (PATH fragments, "1", locale names).
    if (!value || value.length < 12) continue;
    if (!/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    if (!secrets.has(value)) secrets.set(value, key);
  }
  if (secrets.size === 0) return text;
  // One pass, longest value first: a short password inside an API key must not
  // break the key apart before the key is matched, and a secret that occurs in
  // its own «… redacted» marker must not be matched again (that looped forever).
  const pattern = [...secrets.keys()]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return text.replace(new RegExp(pattern, 'g'), (match) => `«${secrets.get(match)} redacted»`);
}
