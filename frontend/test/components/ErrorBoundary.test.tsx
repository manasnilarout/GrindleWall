// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';

/** Throws while `state.throwing` is set; read at render time so a test can heal it. */
const state = { throwing: true };
function Bomb({ message = 'kaboom' }: { message?: string }) {
  if (state.throwing) throw new Error(message);
  return <p>healthy child</p>;
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    state.throwing = true;
    // React and the boundary both log the caught error; keep the output readable.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  it('renders its children untouched when nothing throws', () => {
    state.throwing = false;
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy child')).toBeTruthy();
    expect(screen.queryByText('The UI crashed.')).toBeNull();
  });

  it('catches a throwing child and shows the whole-page crash screen with the message', () => {
    render(
      <ErrorBoundary>
        <Bomb message="render exploded" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('The UI crashed.')).toBeTruthy();
    expect(screen.getByText('render exploded')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry render/ })).toBeTruthy();
    // componentDidCatch logs with its own prefix, so the failure is findable in devtools.
    expect(errorSpy.mock.calls.some((c: unknown[]) => c[0] === 'UI crashed:')).toBe(true);
  });

  it('scopes a crash to one panel when given a panel name', () => {
    render(
      <div>
        <p>sibling stays up</p>
        <ErrorBoundary panel="Runs">
          <Bomb message="bad record" />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByRole('heading', { name: /Runs/ })).toBeTruthy();
    expect(screen.getByText('This panel crashed.')).toBeTruthy();
    expect(screen.getByText('bad record')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeTruthy();
    expect(screen.getByText('sibling stays up')).toBeTruthy();
    expect(screen.queryByText('The UI crashed.')).toBeNull();
  });

  it('a still-broken child crashes again on Retry rather than blanking the page', () => {
    render(
      <ErrorBoundary panel="Turns">
        <Bomb />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(screen.getByText('This panel crashed.')).toBeTruthy();
  });

  /*
   * BUG: Retry never re-renders the children. Both buttons call
   * `this.setState({})`, and a class component's setState MERGES — an empty
   * patch leaves `state.error` exactly where it was, so the boundary renders
   * the crash screen again even after the child has recovered.
   * (src/components/ErrorBoundary.tsx:42 and :57; the fix is
   * `this.setState({ error: undefined })`.)
   */
  it.fails('Retry renders the recovered child (panel boundary)', () => {
    render(
      <ErrorBoundary panel="Turns">
        <Bomb />
      </ErrorBoundary>,
    );
    state.throwing = false;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(screen.getByText('healthy child')).toBeTruthy();
  });

  it.fails('Retry render renders the recovered child (page boundary)', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    state.throwing = false;
    fireEvent.click(screen.getByRole('button', { name: /Retry render/ }));
    expect(screen.getByText('healthy child')).toBeTruthy();
  });

  it('recovers when remounted with a healthy child (the only way out today)', () => {
    const { rerender } = render(
      <ErrorBoundary key="a" panel="Cost">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('This panel crashed.')).toBeTruthy();
    state.throwing = false;
    rerender(
      <ErrorBoundary key="b" panel="Cost">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy child')).toBeTruthy();
  });
});
