// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccessPage } from '../../src/components/AccessPage';
import type { AllowlistState } from '../../src/lib/auth';

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
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'email' } });
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
