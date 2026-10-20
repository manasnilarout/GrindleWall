// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginPage } from '../../src/components/LoginPage';
import { AUTH_USERNAME } from '../../src/lib/auth';

const username = () => screen.getByLabelText('Username') as HTMLInputElement;
const password = () => screen.getByLabelText('Password') as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: /Sign in|Signing in/ }) as HTMLButtonElement;

/** A promise the test settles by hand, to observe the busy state in between. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('LoginPage', () => {
  it('renders the brand, both fields as labels, and the static account by default', () => {
    render(<LoginPage />);
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText('Grindelwald')).toBeTruthy();
    expect(screen.getByText('powered by MagickVoice')).toBeTruthy();
    expect(screen.getByAltText('MagickVoice')).toBeTruthy();
    expect(username().value).toBe(AUTH_USERNAME);
    expect(username().type).toBe('email');
    expect(username().autocomplete).toBe('username');
    expect(password().type).toBe('password');
    expect(password().required).toBe(true);
    expect(password().value).toBe('');
    // No password yet: nothing to submit.
    expect(submit().disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('prefills a configured username', () => {
    render(<LoginPage username="ops@example.com" />);
    expect(username().value).toBe('ops@example.com');
  });

  it.each([
    [3 * 60 * 60 * 1000, '3 hours'],
    [60 * 60 * 1000, '1 hour'],
    [90 * 60 * 1000, '2 hours'],
    [30 * 60 * 1000, '30 minutes'],
    [10_000, '1 minutes'],
  ])('states the session length for a TTL of %i ms as "%s"', (ttl, label) => {
    render(<LoginPage sessionTtlMs={ttl} />);
    expect(screen.getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').includes(`the session lasts ${label}.`))).toBeTruthy();
  });

  it('enables submit once a password is typed', () => {
    render(<LoginPage onSubmit={vi.fn(async () => {})} />);
    fireEvent.change(password(), { target: { value: 'hunter2' } });
    expect(submit().disabled).toBe(false);
  });

  it('submits the trimmed username and the raw password, and shows a busy state until it settles', async () => {
    const pending = deferred();
    const onSubmit = vi.fn(() => pending.promise);
    render(<LoginPage onSubmit={onSubmit} />);
    fireEvent.change(username(), { target: { value: '  admin@magickvoice.com  ' } });
    fireEvent.change(password(), { target: { value: ' pass with spaces ' } });
    fireEvent.click(submit());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('admin@magickvoice.com', ' pass with spaces ');
    expect(submit().textContent).toContain('Signing in…');
    expect(submit().disabled).toBe(true);

    await act(async () => pending.resolve());
    expect(submit().textContent).toContain('Sign in');
    expect(submit().disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('submits on Enter through the form, not only via the button', () => {
    const onSubmit = vi.fn(async () => {});
    const { container } = render(<LoginPage onSubmit={onSubmit} />);
    fireEvent.change(password(), { target: { value: 'pw' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledWith(AUTH_USERNAME, 'pw');
  });

  it('announces a refused sign-in as an alert carrying the thrown message', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('Wrong password.');
    });
    render(<LoginPage onSubmit={onSubmit} />);
    fireEvent.change(password(), { target: { value: 'nope' } });
    fireEvent.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Wrong password.');
    expect(submit().disabled).toBe(false);
  });

  it('clears the previous error when a new attempt starts', async () => {
    const attempt = deferred();
    const onSubmit = vi
      .fn<(u: string, p: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockImplementationOnce(() => attempt.promise);
    render(<LoginPage onSubmit={onSubmit} />);
    fireEvent.change(password(), { target: { value: 'a' } });
    fireEvent.click(submit());
    await screen.findByRole('alert');

    fireEvent.click(submit());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await act(async () => attempt.resolve());
  });

  it('shows an error handed in by the parent, and it wins over a local one', async () => {
    const { rerender } = render(<LoginPage error="Server says no." />);
    expect(screen.getByRole('alert').textContent).toBe('Server says no.');
    const onSubmit = vi.fn(async () => {
      throw new Error('local');
    });
    rerender(<LoginPage error="Server says no." onSubmit={onSubmit} />);
    fireEvent.change(password(), { target: { value: 'x' } });
    fireEvent.click(submit());
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.getByRole('alert').textContent).toBe('Server says no.');
  });

  it('holds the button in its busy state while the parent says it is submitting', () => {
    render(<LoginPage submitting />);
    fireEvent.change(password(), { target: { value: 'x' } });
    expect(submit().textContent).toContain('Signing in…');
    expect(submit().disabled).toBe(true);
  });

  it('does nothing on submit without a handler', () => {
    const { container } = render(<LoginPage />);
    fireEvent.change(password(), { target: { value: 'x' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(submit().textContent).toContain('Sign in');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
