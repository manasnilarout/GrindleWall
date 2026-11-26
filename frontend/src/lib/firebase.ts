import type { FirebaseWebConfig } from './auth';

type FirebaseAuth = typeof import('firebase/auth');

interface Prepared {
  auth: import('firebase/auth').Auth;
  provider: import('firebase/auth').GoogleAuthProvider;
  signInWithPopup: FirebaseAuth['signInWithPopup'];
  signOut: FirebaseAuth['signOut'];
}

let prepared: { key: string; promise: Promise<Prepared> } | undefined;

/**
 * The Firebase app's name. It must NOT contain a colon.
 *
 * When the popup finishes, Google's auth handler (`/__/auth/handler` on the
 * authDomain) hands the result to the hidden Firebase iframe in this page. It
 * finds that iframe by building the key `${apiKey}:${appName}`, splitting it on
 * ":" and comparing part [1] with the iframe's `appName` — so a name with a
 * colon never matches. The handler then falls back to localStorage, which the
 * browser partitions between the popup (first-party) and the iframe (third-party
 * in this page): the result never arrives, and the SDK reports
 * `auth/popup-closed-by-user` right after the user picked an account. Read from
 * the live handler.js on 2026-11-26; `grindelwald:<project>` broke sign-in in
 * production exactly this way.
 */
export function firebaseAppName(projectId: string): string {
  return `grindelwald-${projectId.replace(/:/g, '-')}`;
}

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
      // Destructured straight off `await import()` — the form the bundler can
      // tree-shake — so the chunk drops what is never called (phone, reCAPTCHA, TOTP...).
      const app = import('firebase/app');
      const {
        browserPopupRedirectResolver,
        getAuth,
        GoogleAuthProvider,
        inMemoryPersistence,
        initializeAuth,
        signInWithPopup,
        signOut,
      } = await import('firebase/auth');
      const { getApps, initializeApp } = await app;
      const name = firebaseAppName(cfg.projectId);
      const existing = getApps().find((a) => a.name === name);
      const firebaseApp = existing ?? initializeApp(cfg, name);
      const auth = existing
        ? getAuth(firebaseApp)
        : initializeAuth(firebaseApp, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
      const provider = new GoogleAuthProvider();
      // Always show the account chooser: the person most likely to hit "wrong
      // account" is an intern signed into a personal Gmail as well.
      provider.setCustomParameters({ prompt: 'select_account' });
      return { auth, provider, signInWithPopup, signOut };
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
  const { auth, provider, signInWithPopup, signOut } = await prepareGoogle(cfg);
  try {
    const cred = await signInWithPopup(auth, provider);
    return await cred.user.getIdToken();
  } catch (err) {
    throw new Error(firebaseMessage(err));
  } finally {
    await signOut(auth).catch(() => undefined);
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
