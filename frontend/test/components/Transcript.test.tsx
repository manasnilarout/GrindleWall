// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Transcript } from '../../src/components/Transcript';
import type { Utterance } from '../../src/hooks/useVoiceSession';

const convo: Utterance[] = [
  { role: 'user', text: 'hello', final: true },
  { role: 'assistant', text: 'hi there', final: false },
];
const input = () => screen.getByLabelText('Type a turn') as HTMLInputElement;
const send = () => screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement;

describe('Transcript', () => {
  it('shows the blank-parchment note with no utterances and no hot mic', () => {
    render(<Transcript utterances={[]} speaking={false} />);
    expect(screen.getByText(/The parchment is blank/)).toBeTruthy();
    expect(screen.queryByText('Listening…')).toBeNull();
    // Read-only without onSend.
    expect(screen.queryByRole('textbox')).toBeNull();
    // No count when the parent gives none.
    expect(document.querySelector('.convo-count')).toBeNull();
  });

  it('renders each utterance as a bubble with its role, marking partials', () => {
    const { container } = render(<Transcript utterances={convo} speaking={false} />);
    const bubbles = container.querySelectorAll('.bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].className).toBe('bubble user ');
    expect(bubbles[1].className).toBe('bubble assistant partial');
    // The role is spoken, not only coloured.
    expect(bubbles[0].textContent).toBe('You: hello');
    expect(bubbles[1].textContent).toBe('Assistant: hi there');
    expect(screen.queryByText(/The parchment is blank/)).toBeNull();
  });

  it.each([
    [0, '0 turns'],
    [1, '1 turn'],
    [5, '5 turns'],
  ])('counts %i turns as "%s"', (n, label) => {
    render(<Transcript utterances={[]} speaking={false} turnCount={n} />);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('announces the assistant speaking as a status', () => {
    render(<Transcript utterances={convo} speaking />);
    expect(screen.getByRole('status').textContent).toContain('Assistant speaking');
  });

  it('says it is listening while the mic is open and the last line has settled', () => {
    render(<Transcript utterances={[convo[0]]} speaking={false} micOn />);
    expect(screen.getByText('Listening…')).toBeTruthy();
  });

  it('does not say listening over a partial that is still arriving', () => {
    render(<Transcript utterances={convo} speaking={false} micOn />);
    expect(screen.queryByText('Listening…')).toBeNull();
  });

  it('a hot mic with nothing transcribed replaces the blank note with listening', () => {
    render(<Transcript utterances={[]} speaking={false} micOn />);
    expect(screen.getByText('Listening…')).toBeTruthy();
    expect(screen.queryByText(/The parchment is blank/)).toBeNull();
  });

  it('keeps the list scrolled to the newest line', () => {
    const { container, rerender } = render(<Transcript utterances={[convo[0]]} speaking={false} />);
    const list = container.querySelector('.transcript') as HTMLDivElement;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 480 });
    rerender(<Transcript utterances={convo} speaking={false} />);
    expect(list.scrollTop).toBe(480);
  });

  describe('composer', () => {
    it('is disabled and says why without a session', () => {
      const onSend = vi.fn();
      render(<Transcript utterances={[]} speaking={false} onSend={onSend} canSend={false} />);
      expect(input().disabled).toBe(true);
      expect(input().placeholder).toBe('Connect a session first');
      expect(send().disabled).toBe(true);
    });

    it('sends the trimmed text and clears the field', () => {
      const onSend = vi.fn();
      render(<Transcript utterances={[]} speaking={false} onSend={onSend} canSend />);
      expect(input().placeholder).toBe('Type a turn instead of speaking');
      expect(send().disabled).toBe(true);
      fireEvent.change(input(), { target: { value: '  what time is it?  ' } });
      expect(send().disabled).toBe(false);
      fireEvent.click(send());
      expect(onSend).toHaveBeenCalledExactlyOnceWith('what time is it?');
      expect(input().value).toBe('');
    });

    it('submits on Enter through the form', () => {
      const onSend = vi.fn();
      const { container } = render(<Transcript utterances={[]} speaking={false} onSend={onSend} canSend />);
      fireEvent.change(input(), { target: { value: 'hi' } });
      fireEvent.submit(container.querySelector('form')!);
      expect(onSend).toHaveBeenCalledWith('hi');
    });

    it('never sends whitespace', () => {
      const onSend = vi.fn();
      const { container } = render(<Transcript utterances={[]} speaking={false} onSend={onSend} canSend />);
      fireEvent.change(input(), { target: { value: '   ' } });
      expect(send().disabled).toBe(true);
      fireEvent.submit(container.querySelector('form')!);
      expect(onSend).not.toHaveBeenCalled();
    });

    it('keeps typed text but refuses to send when the session drops', () => {
      const onSend = vi.fn();
      const { container, rerender } = render(<Transcript utterances={[]} speaking={false} onSend={onSend} canSend />);
      fireEvent.change(input(), { target: { value: 'pending turn' } });
      rerender(<Transcript utterances={[]} speaking={false} onSend={onSend} canSend={false} />);
      fireEvent.submit(container.querySelector('form')!);
      expect(onSend).not.toHaveBeenCalled();
      expect(input().value).toBe('pending turn');
    });
  });
});
