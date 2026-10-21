// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TextField } from '../../src/components/TextField';

describe('TextField', () => {
  it('is a labelled text input with spellcheck and autocomplete off', () => {
    render(<TextField label="Voice id" value="abc" onChange={() => {}} placeholder="voice id" />);
    const input = screen.getByLabelText('Voice id') as HTMLInputElement;
    expect(input.type).toBe('text');
    expect(input.value).toBe('abc');
    expect(input.placeholder).toBe('voice id');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.className).toBe('');
  });

  it('reports every keystroke with the full value', () => {
    const onChange = vi.fn();
    render(<TextField label="Name" value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rig Z' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Rig Z');
  });

  it('shows note, hint, mono and disabled when asked', () => {
    const { container } = render(
      <TextField label="Voice id" note="wins over the list" hint="Any id." value="" onChange={() => {}} mono disabled />,
    );
    expect(container.querySelector('.field-note')?.textContent).toBe(' · wins over the list');
    expect(container.querySelector('.field-hint')?.textContent).toBe('Any id.');
    const input = container.querySelector('input')!;
    expect(input.className).toBe('mono');
    expect(input.disabled).toBe(true);
  });

  it('draws no note or hint by default', () => {
    const { container } = render(<TextField label="Description" value="" onChange={() => {}} />);
    expect(container.querySelector('.field-note')).toBeNull();
    expect(container.querySelector('.field-hint')).toBeNull();
  });
});
