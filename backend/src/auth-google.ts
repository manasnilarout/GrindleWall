import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

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
  uid: string;
  name?: string;
}

/** The token is bad or not acceptable: a 401 (or 403-style message) to the user. */
export class GoogleTokenError extends Error {}
/** Google's signing keys could not be fetched: our problem, not the user's — a 503. */
export class GoogleKeysUnavailableError extends Error {}

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

export async function verifyFirebaseIdToken(
  idToken: string,
  opts: { projectId: string; jwksUrl: string; keys?: JWTVerifyGetKey },
): Promise<GoogleIdentity> {
  if (!idToken || typeof idToken !== 'string') throw new GoogleTokenError('Missing ID token');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, opts.keys ?? keySetFor(opts.jwksUrl), {
      algorithms: ['RS256'],
      audience: opts.projectId,
      issuer: `https://securetoken.google.com/${opts.projectId}`,
      clockTolerance: CLOCK_SKEW_S,
      requiredClaims: ['sub', 'iat', 'exp'],
    }));
  } catch (err) {
    if (isKeySourceFailure(err)) throw new GoogleKeysUnavailableError(`Google signing keys unavailable: ${(err as Error).message}`);
    throw new GoogleTokenError(`Invalid ID token: ${(err as Error).message}`);
  }

  if (typeof payload.sub !== 'string' || !payload.sub) throw new GoogleTokenError('Invalid ID token: empty sub');
  const nowS = Date.now() / 1000;
  // jose checks `exp` but leaves a future `iat` alone; Firebase requires it in the past.
  if (typeof payload.iat !== 'number' || payload.iat > nowS + CLOCK_SKEW_S) {
    throw new GoogleTokenError('Invalid ID token: iat in the future');
  }
  const authTime = payload.auth_time;
  if (typeof authTime !== 'number' || authTime > nowS + CLOCK_SKEW_S) {
    throw new GoogleTokenError('Invalid ID token: auth_time missing or in the future');
  }
  const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
  if (firebase?.sign_in_provider !== 'google.com') {
    throw new GoogleTokenError('Only Google sign-in is accepted');
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!email) throw new GoogleTokenError('The Google account has no email');
  if (payload.email_verified !== true) throw new GoogleTokenError('The Google account email is not verified');

  return {
    email,
    uid: payload.sub,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  };
}

/**
 * Whether a verify failure came from fetching the key set rather than from the
 * token. jose's token errors all have their own classes; a network failure
 * (fetch's TypeError), a timeout, an unparseable set, or a non-200 (a bare
 * `JOSEError`) mean the key endpoint is down or blocked. Either way nobody is
 * admitted — this only decides whether the user is told "try again" or "bad token".
 */
function isKeySourceFailure(err: unknown): boolean {
  if (!(err instanceof errors.JOSEError)) return true;
  return err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid || err.constructor === errors.JOSEError;
}
