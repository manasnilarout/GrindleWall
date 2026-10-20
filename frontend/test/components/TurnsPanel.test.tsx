// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TurnsPanel } from '../../src/components/TurnsPanel';
import { SYNTHETIC, pipelineTurn, realtimeTurn, slowTurn } from './fixtures';

vi.mock('../../src/lib/download', () => ({ downloadJson: vi.fn() }));
const { downloadJson } = await import('../../src/lib/download');

const tab = (name: string) => screen.getByRole('button', { name });
const flat = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('TurnsPanel', () => {
  it('starts on the timeline tab, as a pressed toggle in a labelled group', () => {
    render(<TurnsPanel turns={[]} usage={[]} />);
    expect(screen.getByRole('group', { name: 'Turn detail' })).toBeTruthy();
    expect(tab('Timeline').getAttribute('aria-pressed')).toBe('true');
    expect(tab('Usage and cost').getAttribute('aria-pressed')).toBe('false');
    expect(tab('Raw marks').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Complete a turn to collect numbers.')).toBeTruthy();
    // The legend is always drawn on the timeline.
    expect(screen.getByText('LLM to first token')).toBeTruthy();
  });

  it('timeline: one waterfall row per turn, the browser figure stated apart', () => {
    const { container } = render(<TurnsPanel turns={[pipelineTurn, slowTurn]} usage={SYNTHETIC.turns} />);
    expect(container.querySelectorAll('.wf-row')).toHaveLength(2);
    expect(flat(container)).toContain('a median of 1,398 ms after the final transcript arrived');
    expect(flat(container)).toContain('different clock on a different origin');
  });

  it('timeline axis scales to the longest turn including its audio tail', () => {
    const { container } = render(<TurnsPanel turns={[slowTurn]} usage={[]} />);
    // 2120 + 2800 = 4920 ms: the right-most tick is that, in seconds.
    const ticks = [...container.querySelectorAll('.wf-tick')].map((t) => t.textContent);
    expect(ticks).toEqual(['1.2 s', '2.5 s', '3.7 s', '4.9 s']);
  });

  it('exports the turns as JSON', () => {
    render(<TurnsPanel turns={[pipelineTurn]} usage={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /Export turns as JSON/ }));
    expect(downloadJson).toHaveBeenCalledWith([pipelineTurn], expect.stringMatching(/^turns-\d+\.json$/));
  });

  it('usage tab shows the billing table even before a turn completes', () => {
    const { container, rerender } = render(<TurnsPanel turns={[]} usage={[]} />);
    fireEvent.click(tab('Usage and cost'));
    expect(tab('Usage and cost').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Complete a turn to collect numbers.')).toBeNull();
    expect(screen.getByText('No turn completed, so nothing was consumed.')).toBeTruthy();
    // No legend outside the timeline.
    expect(screen.queryByText('LLM to first token')).toBeNull();
    rerender(<TurnsPanel turns={[pipelineTurn]} usage={SYNTHETIC.turns} />);
    expect(container.querySelectorAll('.usage-table tbody tr')).toHaveLength(2);
  });

  it('raw marks: the newest turn, sorted, with deltas and meanings', () => {
    const shuffled = { ...slowTurn, marks: [...slowTurn.marks].reverse() };
    const { container } = render(<TurnsPanel turns={[pipelineTurn, shuffled]} usage={[]} />);
    fireEvent.click(tab('Raw marks'));
    const body = [...container.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
    expect(body.map((r) => r[0])).toEqual([
      'user_speech_end', 'stt_final', 'llm_request_sent', 'llm_first_token', 'tts_request_sent', 'tts_first_audio', 'first_audio_out',
    ]);
    expect(body[0].slice(1, 3)).toEqual(['0', '—']);
    expect(body[1].slice(1, 3)).toEqual(['214', '+214']);
    expect(body[2][2]).toBe('+2');
    expect(body[0][3]).toBe('t0 — every number in this turn is relative to this');
    expect(flat(container)).toContain('Turn 2, the most recent. Audio rendered: 2.8s.');
  });

  it('raw marks with no turns says to complete one', () => {
    render(<TurnsPanel turns={[]} usage={[]} />);
    fireEvent.click(tab('Raw marks'));
    expect(screen.getByText('Complete a turn to collect numbers.')).toBeTruthy();
  });

  it('a realtime turn draws at most its transcript band and the first-audio tick', () => {
    const { container } = render(<TurnsPanel turns={[realtimeTurn]} usage={[]} />);
    expect(container.querySelectorAll('.wf-seg').length).toBeLessThanOrEqual(1);
    expect(container.querySelector('.wf-mark')).toBeTruthy();
    expect(screen.getByText('441 ms')).toBeTruthy();
  });
});
