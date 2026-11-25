import type { FirebaseWebConfig } from './auth';

type FirebaseAuthModule = typeof import('firebase/auth');

interface Prepared {
  mod: FirebaseAuthModule;
  auth: import('firebase/auth').Auth;
  provider: import('firebase/auth').GoogleAuthProvider;
}

let prepared: { key: string; promise: Promise<Prepared> } | undefined;

/**
 * Loads and initialises Firebase Auth ahead of the click. Call it as soon as
 * the login page knows Google is on.
 *
 * Browsers only let a page open a popup shortly after a click (Safari is the
 * strictest). Fetching a few hundred KB of SDK and initialising it between the
 * click and `signInWithPopup` risks `auth/popup-blocked` on a cold load, so the
 * click handler should find all of that already done.
 *
 * In-memory persistence: the Firebase user is signed out right after the popup
 * (see `googleIdToken`), so there is nothing worth writing to IndexedDB.
 */
export function prepareGoogle(cfg: FirebaseWebConfig): Promise<Prepared> {
  const key = JSON.stringify(cfg);
  if (prepared?.key !== key) {
    const promise = (async () => {
      const [{ getApps, initializeApp }, mod] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
      const name = `grindelwald:${cfg.projectId}`;
      const existing = getApps().find((a) => a.name === name);
      const app = existing ?? initializeApp(cfg, name);
      const auth = existing
        ? mod.getAuth(app)
        : mod.initializeAuth(app, {
            persistence: mod.inMemoryPersistence,
            popupRedirectResolver: mod.browserPopupRedirectResolver,
          });
      const provider = new mod.GoogleAuthProvider();
      // Always show the account chooser: the person most likely to hit "wrong
      // account" is an intern signed into a personal Gmail as well.
      provider.setCustomParameters({ prompt: 'select_account' });
      return { mod, auth, provider };
    })();
    // A failed load (offline) must not stick: the next attempt starts over.
    promise.catch(() => {
      if (prepared?.promise === promise) prepared = undefined;
    });
    prepared = { key, promise };
  }
  return prepared.promise;
}

/**
 * Runs Firebase's Google sign-in popup and returns the ID token it yields.
 *
 * Firebase is only the identity step: the backend verifies this token, checks
 * the allowlist, and issues its own session — the one the WebSocket and every
 * route already understand. So the Firebase user is signed straight back out
 * here; keeping it would leave a second session that nothing reads.
 *
 * The SDK is a separate chunk, loaded by `prepareGoogle` — never at app load:
 * the bench never needs it, and the server-side render check must not pull it in.
 */
export async function googleIdToken(cfg: FirebaseWebConfig): Promise<string> {
  const { mod, auth, provider } = await prepareGoogle(cfg);
  try {
    const cred = await mod.signInWithPopup(auth, provider);
    return await cred.user.getIdToken();
  } catch (err) {
    throw new Error(firebaseMessage(err));
  } finally {
    await mod.signOut(auth).catch(() => undefined);
  }
}

/** Firebase errors read as `Firebase: Error (auth/popup-closed-by-user).` — say what happened instead. */
export function firebaseMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in was cancelled.';
    case 'auth/popup-blocked':
      return 'The browser blocked the Google sign-in popup — allow popups for this site and try again.';
    case 'auth/unauthorized-domain':
      return `This site (${typeof location === 'undefined' ? 'this host' : location.hostname}) is not an authorized domain in the Firebase project.`;
    case 'auth/network-request-failed':
      return 'Could not reach Google. Check the connection and try again.';
    default:
      return (err as Error)?.message || 'Google sign-in failed.';
  }
}
