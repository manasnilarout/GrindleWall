// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PromptWidget } from '../../src/components/PromptWidget';

const TERSE = 'You are a voice assistant. Answer in one or two short sentences. Never use lists or markdown.';
const LATENCY = 'Reply with exactly one short sentence, immediately, with no preamble.';
const NATURAL = 'You are a warm, chatty human on a phone call. Use contractions, filler words, and natural hesitation.';

const preset = () => screen.getByLabelText('Preset') as HTMLSelectElement;
const text = () => screen.getByLabelText('System prompt text') as HTMLTextAreaElement;

describe('PromptWidget', () => {
  it('names the preset the prompt matches and shows the text', () => {
    render(<PromptWidget systemPrompt={TERSE} onSystemPromptChange={() => {}} locked={false} />);
    expect(screen.getByRole('heading', { name: /System prompt/ })).toBeTruthy();
    expect(preset().value).toBe('Terse assistant');
    expect([...preset().options].map((o) => o.value)).toEqual(['Terse assistant', 'Latency probe', 'Naturalness probe']);
    expect(text().value).toBe(TERSE);
    expect(screen.queryByText('Locked while live')).toBeNull();
  });

  it('says Custom for a hand-edited prompt instead of claiming the last preset', () => {
    render(<PromptWidget systemPrompt="Be a pirate." onSystemPromptChange={() => {}} locked={false} />);
    expect(preset().value).toBe('');
    expect(preset().options[0].textContent).toBe('Custom');
    expect(preset().options).toHaveLength(4);
  });

  it.each([
    ['Latency probe', LATENCY],
    ['Naturalness probe', NATURAL],
    ['Terse assistant', TERSE],
  ])('picking "%s" hands the parent its full text', (name, full) => {
    const onChange = vi.fn();
    render(<PromptWidget systemPrompt="custom" onSystemPromptChange={onChange} locked={false} />);
    fireEvent.change(preset(), { target: { value: name } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(full);
  });

  it('ignores picking "Custom" itself, which has no text to apply', () => {
    const onChange = vi.fn();
    render(<PromptWidget systemPrompt="custom" onSystemPromptChange={onChange} locked={false} />);
    fireEvent.change(preset(), { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('forwards free-text edits', () => {
    const onChange = vi.fn();
    render(<PromptWidget systemPrompt="" onSystemPromptChange={onChange} locked={false} />);
    expect(text().placeholder).toBe('You are a voice assistant…');
    fireEvent.change(text(), { target: { value: 'Speak Hindi.' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('Speak Hindi.');
  });

  it('locks both controls while live and says so', () => {
    render(<PromptWidget systemPrompt={TERSE} onSystemPromptChange={() => {}} locked />);
    expect(preset().disabled).toBe(true);
    expect(text().disabled).toBe(true);
    expect(screen.getByText('Locked while live')).toBeTruthy();
  });
});
