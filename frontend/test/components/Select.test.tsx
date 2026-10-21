// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Select } from '../../src/components/Select';

const options = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo', hint: 'slow' },
  { id: 'c', name: 'Charlie', disabled: true },
];

describe('Select', () => {
  it('is a labelled select holding every option, hints appended', () => {
    render(<Select label="Model" value="a" options={options} onChange={() => {}} />);
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(select.value).toBe('a');
    const opts = [...select.options];
    expect(opts.map((o) => o.value)).toEqual(['a', 'b', 'c']);
    expect(opts.map((o) => o.textContent)).toEqual(['Alpha', 'Bravo — slow', 'Charlie']);
    expect(opts[2].disabled).toBe(true);
    expect(select.className).toBe('');
    expect(select.disabled).toBe(false);
  });

  it('calls onChange with the picked id', () => {
    const onChange = vi.fn();
    render(<Select label="Model" value="a" options={options} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('renders the note after the label and the hint under the control', () => {
    const { container } = render(
      <Select label="Language" note="44 on this model" hint="Pick one" value="a" options={options} onChange={() => {}} />,
    );
    expect(container.querySelector('.field-note')?.textContent).toBe(' · 44 on this model');
    expect(container.querySelector('.field-hint')?.textContent).toBe('Pick one');
  });

  it('omits note and hint when absent, sets mono, and can be disabled', () => {
    const { container } = render(<Select label="Voice" value="" options={[]} onChange={() => {}} disabled mono />);
    expect(container.querySelector('.field-note')).toBeNull();
    expect(container.querySelector('.field-hint')).toBeNull();
    const select = container.querySelector('select')!;
    expect(select.className).toBe('mono');
    expect(select.disabled).toBe(true);
    expect(select.options).toHaveLength(0);
  });
});
