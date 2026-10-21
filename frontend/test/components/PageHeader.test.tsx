// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PageHeader } from '../../src/components/PageHeader';

describe('PageHeader', () => {
  it('renders only the title when given nothing else', () => {
    const { container } = render(<PageHeader title="Runs" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Runs' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.querySelector('.eyebrow')).toBeNull();
    expect(container.querySelector('.page-sub')).toBeNull();
    expect(container.querySelector('.page-actions')).toBeNull();
  });

  it('renders an empty crumb list as nothing', () => {
    render(<PageHeader title="Bench" crumbs={[]} />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('makes linked crumbs buttons and the current page plain text with aria-current', () => {
    const onSelect = vi.fn();
    render(<PageHeader title="Run" crumbs={[{ label: 'Runs', onSelect }, { label: 'Oct 20, 12:00' }]} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    const link = within(nav).getByRole('button', { name: 'Runs' });
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const current = within(nav).getByText('Oct 20, 12:00');
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getAllByRole('button')).toHaveLength(1);
    // One separator, between the two crumbs, hidden from assistive tech.
    const seps = nav.querySelectorAll('[aria-hidden="true"]');
    expect(seps).toHaveLength(1);
    expect(seps[0].textContent).toBe('›');
  });

  it('renders eyebrow, sub, badges and actions in their slots', () => {
    const { container } = render(
      <PageHeader
        title="Rig A"
        eyebrow="Mischief managed"
        sub="2 turns"
        badges={<span className="tag">Pipeline</span>}
        actions={<button type="button">Export</button>}
      />,
    );
    expect(container.querySelector('.eyebrow')?.textContent).toBe('Mischief managed');
    expect(container.querySelector('.page-sub')?.textContent).toBe('2 turns');
    expect(container.querySelector('.page-title-row .tag')?.textContent).toBe('Pipeline');
    expect(within(container.querySelector('.page-actions') as HTMLElement).getByRole('button', { name: 'Export' })).toBeTruthy();
  });
});
