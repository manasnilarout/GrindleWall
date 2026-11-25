import { useState, type FormEvent } from 'react';
import { AUTH_USERNAME } from '../lib/auth';

interface Props {
  username?: string;
  sessionTtlMs?: number;
  error?: string;
  submitting?: boolean;
  onSubmit?: (username: string, password: string) => Promise<void>;
  /** Google sign-in is configured: it becomes the main way in. */
  google?: boolean;
  /** The admin password form is configured. With `google`, it folds away under "Admin sign-in". */
  password?: boolean;
  onGoogle?: () => Promise<void>;
}

/**
 * The gate in front of the bench.
 *
 * Google (through Firebase) is the way in for anyone on an allowed domain; the
 * backend verifies the token and checks the allowlist. The single admin
 * account's password form stays as a fallback: its password is HMAC-SHA256'd
 * with the secret from GET /api/auth/config before it is posted — the backend
 * recomputes the same digest of AUTH_PASSWORD and compares.
 */
export function LoginPage({
  username = AUTH_USERNAME,
  sessionTtlMs = 3 * 60 * 60 * 1000,
  error,
  submitting = false,
  onSubmit,
  google = false,
  password: passwordEnabled = true,
  onGoogle,
}: Props) {
  const [email, setEmail] = useState(username);
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  const hours = sessionTtlMs / 3_600_000;
  const ttlLabel =
    hours >= 1
      ? `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`
      : `${Math.max(1, Math.round(sessionTtlMs / 60_000))} minutes`;
  const message = error ?? localError;
  const waiting = submitting || busy || googleBusy;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSubmit) return;
    setLocalError(undefined);
    setBusy(true);
    try {
      await onSubmit(email.trim(), password);
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleGoogle = async () => {
    if (!onGoogle) return;
    setLocalError(undefined);
    setGoogleBusy(true);
    try {
      await onGoogle();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setGoogleBusy(false);
    }
  };

  const alert = message && (
    <div className="banner error login-error" role="alert">
      {message}
    </div>
  );

  const passwordFields = (
    <>
      <label className="field">
        <span className="field-label">Username</span>
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span className="field-label">Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
    </>
  );

  const card = google ? (
    <div className="login-card">
      <span className="eyebrow">Members only</span>
      <h1>Sign in</h1>
      <p className="login-lede">
        Use your Google work account. Only approved domains get in; the session lasts {ttlLabel}.
      </p>

      {alert}

      <button
        type="button"
        className="btn login-google"
        onClick={() => void handleGoogle()}
        disabled={waiting}
      >
        <GoogleMark />
        {googleBusy ? 'Waiting for Google…' : 'Sign in with Google'}
      </button>

      {passwordEnabled && (
        <details className="login-admin">
          <summary>Admin sign-in</summary>
          <form onSubmit={(e) => void handleSubmit(e)}>
            {passwordFields}
            <button type="submit" className="btn login-submit" disabled={waiting || !password}>
              {busy || submitting ? 'Signing in…' : 'Sign in as admin'}
            </button>
          </form>
        </details>
      )}
    </div>
  ) : (
    <form className="login-card" onSubmit={(e) => void handleSubmit(e)}>
      <span className="eyebrow">Members only</span>
      <h1>Sign in</h1>
      <p className="login-lede">
        A single static account. The password is HMAC&apos;d in the browser before it is sent; the session lasts{' '}
        {ttlLabel}.
      </p>

      {passwordFields}

      {alert}

      <button type="submit" className="btn primary login-submit" disabled={waiting || !password}>
        {waiting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );

  return (
    <main className="login">
      <section className="login-sky">
        <span className="brand login-brand">
          <img className="brand-logo" src="/magickvoice-logo.png" alt="MagickVoice" />
          <span className="brand-copy">
            <span className="brand-name">Grindelwald</span>
            <span className="brand-byline">powered by MagickVoice</span>
          </span>
        </span>
        <svg className="login-stars" width="180" height="96" viewBox="0 0 180 96" fill="var(--gold)" aria-hidden="true">
          <path d="M126 14a24 24 0 1 0 26 32a19 19 0 1 1 -26 -32z" opacity="0.9" />
          <path d="M44 40l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" opacity="0.85" />
          <path d="M92 70l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" opacity="0.7" />
          <circle cx="18" cy="18" r="1.4" opacity="0.7" />
          <circle cx="70" cy="14" r="1.1" opacity="0.6" />
          <circle cx="96" cy="34" r="1.6" opacity="0.8" />
          <circle cx="160" cy="76" r="1.2" opacity="0.6" />
          <circle cx="24" cy="78" r="1.6" opacity="0.5" />
          <circle cx="140" cy="88" r="1" opacity="0.6" />
        </svg>
        <p className="login-motto">I solemnly swear I am up to no good</p>
      </section>

      <section className="login-ground">{card}</section>
    </main>
  );
}

/** Google's "G", in its own colours — the one place the brand palette does not apply. */
function GoogleMark() {
  return (
    <svg className="login-google-mark" width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
