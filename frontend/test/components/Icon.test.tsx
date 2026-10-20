// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Icon, PanelIcon } from '../../src/components/Icon';

describe('Icon', () => {
  it('renders a decorative svg at the requested size with the given class', () => {
    const { container } = render(<Icon name="mic" size={20} className="extra" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('height')).toBe('20');
    expect(svg.getAttribute('class')).toContain('extra');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.childNodes.length).toBeGreaterThan(0);
  });

  it('defaults to 14px', () => {
    const { container } = render(<Icon name="close" />);
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('14');
  });

  it('PanelIcon is a 16px icon with the panel-icon class', () => {
    const { container } = render(<PanelIcon name="potion" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('class')).toContain('panel-icon');
  });
});
