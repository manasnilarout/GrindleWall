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

  const hours = Math.round(sessionTtlMs / 3_600_000);
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
    <div className="app login-app">
      <header className="topbar">
        <span className="brand">
          <img className="brand-logo" src="/magickvoice-logo.png" alt="MagickVoice" />
          <span className="brand-copy">
            <span className="brand-name">Grindelwald</span>
            <span className="brand-byline">powered by MagickVoice</span>
          </span>
        </span>
      </header>

      <div className="login-wrap">
        <form className="panel login-card" onSubmit={(e) => void handleSubmit(e)}>
          <h1>Sign in</h1>
          <p className="muted">
            A single static account. The password is HMAC&apos;d in the browser before
            it is sent; the session lasts {hours} hour{hours === 1 ? '' : 's'}.
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

          {message && <div className="inline-banner banner error">{message}</div>}

          <button type="submit" className="btn primary login-submit" disabled={waiting || !password}>
            {waiting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
