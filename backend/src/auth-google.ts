import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { HttpError } from './http-error.js';

/**
 * Verifies a Firebase Auth ID token — what the browser gets back from the
 * Google sign-in popup — without the Admin SDK.
 *
 * The claim checks follow Firebase's "verify ID tokens using a third-party JWT
 * library" page: RS256, signed by one of the keys published for
 * securetoken@system.gserviceaccount.com, `aud` = the project id, `iss` =
 * https://securetoken.google.com/<project id>, a non-empty `sub`, `iat` and
 * `auth_time` in the past, `exp` in the future.
 *
 * The KEY SOURCE differs from that page: it names the x509 certificate URL
 * (`/robot/v1/metadata/x509/...`), and this reads the same account's JWK set
 * (`/service_accounts/v1/jwk/...`), which `jose` can consume and cache
 * directly. That the two serve the same keys is a measurement, not a doc
 * claim — `npm run firebase:keys` re-checks it key for key.
 *
 * On top of a valid token, this layer insists the identity is a GOOGLE
 * account with a VERIFIED email: Firebase projects can enable other
 * providers, and an unverified email/password account could otherwise claim
 * `intern@magickvoice.com` and walk through the domain allowlist.
 */

export interface GoogleIdentity {
  email: string;
}

/** The token is bad or not acceptable. The detail goes to the log; the user gets `publicMessage`. */
export class GoogleTokenError extends HttpError {
  constructor(detail: string, publicMessage = detail) {
    super(401, detail, publicMessage);
  }
}
/** Google's signing keys could not be fetched: our problem, not the user's. */
export class GoogleKeysUnavailableError extends HttpError {
  constructor(detail: string) {
    super(503, detail, 'Google sign-in is temporarily unavailable. Try again in a minute.');
  }
}

const invalid = (detail: string) => new GoogleTokenError(`Invalid ID token: ${detail}`, 'Invalid sign-in token');

/** Clock tolerance for `exp` / `iat` / `auth_time`, seconds. */
const CLOCK_SKEW_S = 60;

const keySets = new Map<string, JWTVerifyGetKey>();
function keySetFor(jwksUrl: string): JWTVerifyGetKey {
  let set = keySets.get(jwksUrl);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 6 * 3_600_000 });
    keySets.set(jwksUrl, set);
  }
  return set;
}

/**
 * The key lookup, with its failures sorted at the source. An unknown or
 * ambiguous `kid` is the TOKEN's fault; anything else thrown while getting
 * keys (network, timeout, non-200, an unparseable set) means Google's key
 * endpoint is down or blocked. Nobody is admitted either way — this only picks
 * "bad token" over "try again".
 */
function keysFrom(source: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await source(header, token);
    } catch (err) {
      if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) throw err;
      throw new GoogleKeysUnavailableError(`Google signing keys unavailable: ${(err as Error).message}`);
    }
  };
}

export async function verifyFirebaseIdToken(
  idToken: string,
  opts: { projectId: string; jwksUrl: string; keys?: JWTVerifyGetKey },
): Promise<GoogleIdentity> {
  if (!idToken || typeof idToken !== 'string') throw new GoogleTokenError('Missing ID token');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keysFrom(opts.keys ?? keySetFor(opts.jwksUrl)), {
      algorithms: ['RS256'],
      audience: opts.projectId,
      issuer: `https://securetoken.google.com/${opts.projectId}`,
      clockTolerance: CLOCK_SKEW_S,
      requiredClaims: ['sub', 'iat', 'exp'],
    }));
  } catch (err) {
    if (err instanceof GoogleKeysUnavailableError) throw err;
    throw invalid((err as Error).message);
  }

  if (typeof payload.sub !== 'string' || !payload.sub) throw invalid('empty sub');
  const nowS = Date.now() / 1000;
  // jose checks `exp` but leaves a future `iat` alone; Firebase requires it in the past.
  if (typeof payload.iat !== 'number' || payload.iat > nowS + CLOCK_SKEW_S) throw invalid('iat in the future');
  const authTime = payload.auth_time;
  if (typeof authTime !== 'number' || authTime > nowS + CLOCK_SKEW_S) {
    throw invalid('auth_time missing or in the future');
  }
  const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
  if (firebase?.sign_in_provider !== 'google.com') throw new GoogleTokenError('Only Google sign-in is accepted');
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) throw new GoogleTokenError('The Google account has no email');
  if (payload.email_verified !== true) throw new GoogleTokenError('The Google account email is not verified');
  return { email };
}
