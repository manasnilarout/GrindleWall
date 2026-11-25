import type { FirebaseWebConfig } from './auth';

/**
 * Runs Firebase's Google sign-in popup and returns the ID token it yields.
 *
 * Firebase is only the identity step: the backend verifies this token, checks
 * the allowlist, and issues its own session — the one the WebSocket and every
 * route already understand. So the Firebase user is signed straight back out
 * here; keeping it would leave a second session that nothing reads.
 *
 * The SDK is imported on click, not at load: it is a few hundred KB the bench
 * never needs, and the server-side render check must not pull it in.
 */
export async function googleIdToken(cfg: FirebaseWebConfig): Promise<string> {
  const [{ getApp, getApps, initializeApp }, auth] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  const name = 'grindelwald';
  const app = getApps().some((a) => a.name === name) ? getApp(name) : initializeApp(cfg, name);
  const fbAuth = auth.getAuth(app);
  const provider = new auth.GoogleAuthProvider();
  // Always show the account chooser: the person most likely to hit "wrong
  // account" is an intern signed into a personal Gmail as well.
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const cred = await auth.signInWithPopup(fbAuth, provider);
    return await cred.user.getIdToken();
  } catch (err) {
    throw new Error(firebaseMessage(err));
  } finally {
    await auth.signOut(fbAuth).catch(() => undefined);
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
