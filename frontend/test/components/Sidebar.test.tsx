// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from '../../src/components/Sidebar';
import { RIG_COLORS } from '../../src/lib/rigs';
import { baseRig, murfRig, pickerProviders } from './fixtures';

const rigB = { ...murfRig, id: 'rig-b', name: 'Rig B', colorIndex: 1 };
const props = (over: Partial<Parameters<typeof Sidebar>[0]> = {}): Parameters<typeof Sidebar>[0] => ({
  view: 'bench',
  onNavigate: vi.fn(),
  rigs: [baseRig, rigB],
  activeRigId: baseRig.id,
  providers: pickerProviders,
  scores: { [baseRig.id]: { ttfaMedianMs: 612.4, turns: 4 } },
  locked: false,
  onSelectRig: vi.fn(),
  onAddRig: vi.fn(),
  backend: 'ready',
  ...over,
});
const rigButton = (name: string) => screen.getByText(name).closest('button') as HTMLButtonElement;

describe('Sidebar', () => {
  it('is the main navigation with the brand, both views and every rig', () => {
    render(<Sidebar {...props()} />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('Grindelwald')).toBeTruthy();
    expect(within(nav).getByText('powered by MagickVoice')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Bench/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /Runs/ }).hasAttribute('aria-current')).toBe(false);
    const list = screen.getByRole('list', { name: 'Rigs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('marks Runs as the current page when it is', () => {
    render(<Sidebar {...props({ view: 'runs' })} />);
    expect(screen.getByRole('button', { name: /Runs/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /Bench/ }).hasAttribute('aria-current')).toBe(false);
  });

  it('navigates with the view name', () => {
    const p = props();
    render(<Sidebar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Runs/ }));
    fireEvent.click(screen.getByRole('button', { name: /Bench/ }));
    expect(p.onNavigate).toHaveBeenNthCalledWith(1, 'runs');
    expect(p.onNavigate).toHaveBeenNthCalledWith(2, 'bench');
  });

  it('each rig shows its letter, colour, chain and — once run here — its median', () => {
    const { container } = render(<Sidebar {...props()} />);
    const a = rigButton('Rig A');
    expect(a.className).toBe('rig-item on');
    expect(a.getAttribute('aria-current')).toBe('true');
    expect(a.getAttribute('title')).toBe('Mock (canned) · Mock (echo) · Sarvam Bulbul');
    expect(within(a).getByText('Mock (canned) · Mock (echo) · Sarvam Bulbul')).toBeTruthy();
    expect(within(a).getByText('612 ms')).toBeTruthy();
    const badges = container.querySelectorAll('.rig-badge');
    expect([...badges].map((b) => b.textContent)).toEqual(['A', 'B']);
    expect((badges[1] as HTMLElement).style.background).toBe('rgb(42, 63, 122)');
    expect(RIG_COLORS[1]).toBe('#2a3f7a');
    // Not run here yet: no number, and no lone dash either.
    const b = rigButton('Rig B');
    expect(b.className).toBe('rig-item ');
    expect(b.querySelector('.rig-item-ms')).toBeNull();
  });

  it('selects a rig by id', () => {
    const p = props();
    render(<Sidebar {...p} />);
    fireEvent.click(rigButton('Rig B'));
    expect(p.onSelectRig).toHaveBeenCalledExactlyOnceWith('rig-b');
  });

  it('adds a rig, but not before the catalog has loaded', () => {
    const p = props();
    const { rerender } = render(<Sidebar {...p} />);
    const add = screen.getByRole('button', { name: 'Add a rig' }) as HTMLButtonElement;
    fireEvent.click(add);
    expect(p.onAddRig).toHaveBeenCalledTimes(1);
    rerender(<Sidebar {...p} providers={[]} />);
    expect(add.disabled).toBe(true);
    // Without providers there is no chain to show.
    expect(rigButton('Rig A').getAttribute('title')).toBe('Rig A');
  });

  it('locks the other rigs and the add button during a live session, but not the live one', () => {
    const p = props({ locked: true });
    render(<Sidebar {...p} />);
    expect(rigButton('Rig A').disabled).toBe(false);
    expect(rigButton('Rig B').disabled).toBe(true);
    expect(rigButton('Rig B').getAttribute('title')).toBe('End the conversation to switch rig');
    expect((screen.getByRole('button', { name: 'Add a rig' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Locked while Rig A is live')).toBeTruthy();
    fireEvent.click(rigButton('Rig B'));
    expect(p.onSelectRig).not.toHaveBeenCalled();
  });

  it('says "Locked while live" when the active rig is unknown', () => {
    render(<Sidebar {...props({ locked: true, activeRigId: 'gone' })} />);
    expect(screen.getByText('Locked while live')).toBeTruthy();
  });

  it.each([
    ['ready', 'Catalog loaded', 'dot '],
    ['loading', 'Reaching backend…', 'dot wait'],
    ['unreachable', 'Backend unreachable', 'dot off'],
  ] as const)('backend %s reads "%s"', (backend, words, dot) => {
    const { container } = render(<Sidebar {...props({ backend })} />);
    expect(screen.getByText(words)).toBeTruthy();
    expect(container.querySelector('.side-status .dot')?.className).toBe(dot);
  });

  it('shows the signed-in user and a working Sign out', () => {
    const onLogout = vi.fn();
    const { container } = render(<Sidebar {...props({ username: 'admin@magickvoice.com', onLogout })} />);
    expect(screen.getByText('admin@magickvoice.com').getAttribute('title')).toBe('admin@magickvoice.com');
    expect(container.querySelector('.side-avatar')?.textContent).toBe('A');
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('a username without logout shows no Sign out; neither shows no user block', () => {
    const { container, rerender } = render(<Sidebar {...props({ username: 'x@y.z' })} />);
    expect(screen.queryByRole('button', { name: /Sign out/ })).toBeNull();
    expect(container.querySelector('.side-user')).toBeTruthy();
    rerender(<Sidebar {...props()} />);
    expect(container.querySelector('.side-user')).toBeNull();
  });
});
