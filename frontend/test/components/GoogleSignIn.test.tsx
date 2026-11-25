// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { LoginPage } from '../../src/components/LoginPage';
import { AccessPage } from '../../src/components/AccessPage';
import { Sidebar } from '../../src/components/Sidebar';
import { useAuth } from '../../src/hooks/useAuth';
import { AUTH_STORAGE_KEY, type AllowlistState } from '../../src/lib/auth';
import { routedFetch } from './fixtures';

const googleIdToken = vi.fn<(cfg: unknown) => Promise<string>>();
vi.mock('../../src/lib/firebase', () => ({ googleIdToken: (cfg: unknown) => googleIdToken(cfg) }));

const FIREBASE = { apiKey: 'AIza-public', authDomain: 'gw.firebaseapp.com', projectId: 'gw' };

describe('LoginPage with Google', () => {
  it('leads with Google and folds the admin password form away', () => {
    render(<LoginPage google password onGoogle={vi.fn(async () => {})} />);
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeTruthy();
    expect(screen.getByText('Admin sign-in')).toBeTruthy();
    const details = screen.getByText('Admin sign-in').closest('details')!;
    expect(details.open).toBe(false);
    expect(screen.getByText(/Only approved domains get in/)).toBeTruthy();
  });

  it('has no admin form when the password login is not configured', () => {
    render(<LoginPage google password={false} />);
    expect(screen.queryByText('Admin sign-in')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('shows the busy state while the popup is open, and a refusal as an alert', async () => {
    let reject!: (e: Error) => void;
    const onGoogle = vi.fn(() => new Promise<void>((_, rej) => (reject = rej)));
    render(<LoginPage google onGoogle={onGoogle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    expect(screen.getByRole('button', { name: 'Waiting for Google…' })).toHaveProperty('disabled', true);
    await act(async () => reject(new Error('someone@gmail.com is not allowed to sign in.')));
    expect(screen.getByRole('alert').textContent).toContain('someone@gmail.com is not allowed');
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toHaveProperty('disabled', false);
  });

  it('the folded admin form still submits the password', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<LoginPage google password onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as admin' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('admin@magickvoice.com', 'pw'));
  });
});

describe('useAuth with Google', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.unstubAllGlobals();
    googleIdToken.mockReset();
  });

  it('trades the Firebase ID token for a backend session and stores it', async () => {
    googleIdToken.mockResolvedValue('firebase-id-token');
    const session = { token: 't'.repeat(64), username: 'intern@magickvoice.com', expiresAt: Date.now() + 3_600_000, role: 'member', method: 'google' };
    const fetch = routedFetch(async (url, init) => {
      if (url === '/api/auth/config') return { body: { required: true, username: 'admin@magickvoice.com', sessionTtlMs: 3_600_000, password: false, google: FIREBASE } };
      if (url === '/api/auth/google') {
        expect(JSON.parse(String(init?.body))).toEqual({ idToken: 'firebase-id-token' });
        return { body: session };
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetch);

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('login'));
    expect(result.current.googleEnabled).toBe(true);
    expect(result.current.passwordEnabled).toBe(false);

    await act(() => result.current.signInWithGoogle());
    expect(googleIdToken).toHaveBeenCalledWith(FIREBASE);
    expect(result.current.status).toBe('ready');
    expect(result.current.isAdmin).toBe(false);
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!).username).toBe('intern@magickvoice.com');
  });

  it('a backend refusal stays on the login page with the server message', async () => {
    googleIdToken.mockResolvedValue('tok');
    vi.stubGlobal(
      'fetch',
      routedFetch(async (url) => {
        if (url === '/api/auth/config') return { body: { required: true, username: 'a', sessionTtlMs: 1, google: FIREBASE } };
        if (url === '/api/auth/google') return { status: 403, body: { error: 'x@gmail.com is not allowed to sign in.' } };
        return undefined;
      }),
    );
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('login'));
    let err: Error | undefined;
    await act(async () => {
      await result.current.signInWithGoogle().catch((e: Error) => (err = e));
    });
    expect(err?.message).toBe('x@gmail.com is not allowed to sign in.');
    expect(result.current.status).toBe('login');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('an older backend with only hmacSecret still counts as password-enabled; a role-less stored session is admin', async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'a'.repeat(64), username: 'admin@magickvoice.com', expiresAt: Date.now() + 3_600_000 }));
    vi.stubGlobal(
      'fetch',
      routedFetch(async (url) => {
        if (url === '/api/auth/config') return { body: { required: true, username: 'admin@magickvoice.com', sessionTtlMs: 3_600_000, hmacSecret: 'k' } };
        if (url === '/api/auth/session') return { body: { required: true, session: { token: 'a'.repeat(64), username: 'admin@magickvoice.com', expiresAt: Date.now() + 3_600_000 } } };
        return undefined;
      }),
    );
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.passwordEnabled).toBe(true);
    expect(result.current.googleEnabled).toBe(false);
    expect(result.current.isAdmin).toBe(true);
  });
});

describe('AccessPage', () => {
  const state: AllowlistState = {
    entries: [
      { kind: 'domain', value: 'magickvoice.com', source: 'env' },
      { kind: 'domain', value: 'partner.io', source: 'admin', addedBy: 'admin@magickvoice.com', addedAt: Date.UTC(2026, 10, 1) },
    ],
    adminEmails: ['boss@magickvoice.com'],
  };
  afterEach(() => vi.restoreAllMocks());

  it('lists pinned and added entries; only added ones are removable', async () => {
    const api = { fetch: vi.fn(async () => state), add: vi.fn(), remove: vi.fn() };
    render(<AccessPage api={api} />);
    await screen.findByText('@partner.io');
    expect(screen.getByText('@magickvoice.com')).toBeTruthy();
    expect(screen.getByText('Pinned (AUTH_ALLOWED_DOMAINS)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove magickvoice.com' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove partner.io' })).toBeTruthy();
    expect(screen.getByText('boss@magickvoice.com')).toBeTruthy();
  });

  it('adds a single address and clears the field', async () => {
    const after = { ...state, entries: [...state.entries, { kind: 'email' as const, value: 'friend@gmail.com', source: 'admin' as const }] };
    const api = { fetch: vi.fn(async () => state), add: vi.fn(async () => after), remove: vi.fn() };
    render(<AccessPage api={api} />);
    await screen.findByText('@partner.io');
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'email' } });
    const input = screen.getByLabelText('Email address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' friend@gmail.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('friend@gmail.com');
    expect(api.add).toHaveBeenCalledWith({ kind: 'email', value: 'friend@gmail.com' });
    expect(input.value).toBe('');
  });

  it('removes after confirming, and shows a server error as an alert', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = {
      fetch: vi.fn(async () => state),
      add: vi.fn(async () => {
        throw new Error('"x" is not a domain (e.g. example.com)');
      }),
      remove: vi.fn(async () => ({ ...state, entries: [state.entries[0]] })),
    };
    render(<AccessPage api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove partner.io' }));
    await waitFor(() => expect(screen.queryByText('@partner.io')).toBeNull());
    expect(api.remove).toHaveBeenCalledWith({ kind: 'domain', value: 'partner.io' });

    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toContain('is not a domain');
  });

  it('does nothing when the removal is not confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = { fetch: vi.fn(async () => state), add: vi.fn(), remove: vi.fn() };
    render(<AccessPage api={api} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove partner.io' }));
    expect(api.remove).not.toHaveBeenCalled();
  });
});

describe('Sidebar Access entry', () => {
  const base = {
    view: 'bench' as const,
    onNavigate: vi.fn(),
    rigs: [],
    activeRigId: '',
    providers: [],
    scores: {},
    locked: false,
    onSelectRig: vi.fn(),
    onAddRig: vi.fn(),
    backend: 'ready' as const,
  };

  it('is hidden from members and shown to admins', () => {
    const { rerender } = render(<Sidebar {...base} />);
    expect(screen.queryByRole('button', { name: 'Access' })).toBeNull();
    rerender(<Sidebar {...base} showAccess view="access" />);
    const link = screen.getByRole('button', { name: 'Access' });
    expect(link.getAttribute('aria-current')).toBe('page');
    fireEvent.click(link);
    expect(base.onNavigate).toHaveBeenCalledWith('access');
  });
});
