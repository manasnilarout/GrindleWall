import { useState, type FormEvent } from 'react';
import { AUTH_USERNAME } from '../lib/auth';

interface Props {
  username?: string;
  sessionTtlMs?: number;
  error?: string;
  submitting?: boolean;
  onSubmit?: (username: string, password: string) => Promise<void>;
}

/**
 * Naive gate in front of the bench. The password is HMAC-SHA256'd with the
 * secret from GET /api/auth/config before it is posted — the backend
 * recomputes the same digest of AUTH_PASSWORD and compares.
 */
export function LoginPage({
  username = AUTH_USERNAME,
  sessionTtlMs = 3 * 60 * 60 * 1000,
  error,
  submitting = false,
  onSubmit,
}: Props) {
  const [email, setEmail] = useState(username);
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const hours = sessionTtlMs / 3_600_000;
  const ttlLabel =
    hours >= 1
      ? `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`
      : `${Math.max(1, Math.round(sessionTtlMs / 60_000))} minutes`;
  const message = error ?? localError;
  const waiting = submitting || busy;

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

      <section className="login-ground">
        <form className="login-card" onSubmit={(e) => void handleSubmit(e)}>
          <span className="eyebrow">Members only</span>
          <h1>Sign in</h1>
          <p className="login-lede">
            A single static account. The password is HMAC&apos;d in the browser before it is sent; the session lasts{' '}
            {ttlLabel}.
          </p>

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

          {message && (
            <div className="banner error login-error" role="alert">
              {message}
            </div>
          )}

          <button type="submit" className="btn primary login-submit" disabled={waiting || !password}>
            {waiting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
