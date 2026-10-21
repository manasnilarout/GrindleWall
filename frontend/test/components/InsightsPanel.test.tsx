// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostPanel, InsightsPanel, Stat } from '../../src/components/InsightsPanel';
import type { TurnRecord } from '../../src/hooks/useVoiceSession';
import { NOW, SYNTHETIC, pipelineTurn, realtimeTurn, slowTurn } from './fixtures';

const flat = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('InsightsPanel', () => {
  it('asks for a turn before it has any', () => {
    render(<InsightsPanel turns={[]} />);
    expect(screen.getByRole('heading', { name: /Time to first audio/ })).toBeTruthy();
    expect(screen.getByText('Complete a turn to collect numbers.')).toBeTruthy();
  });

  it('a turn with no server TTFA counts as no turn', () => {
    render(<InsightsPanel turns={[{ ...pipelineTurn, derived: {} }]} />);
    expect(screen.getByText('Complete a turn to collect numbers.')).toBeTruthy();
  });

  it('headlines the server-side median, spread, browser figure and the slowest leg', () => {
    const { container } = render(<InsightsPanel turns={[pipelineTurn, slowTurn]} />);
    expect(screen.getByText('median of 2')).toBeTruthy();
    // median(548, 2120) = 1334
    expect(container.querySelector('.hero-v')?.textContent).toBe('1,334');
    const stats = flat(container.querySelector('.stat-row')!);
    expect(stats).toContain('2,120p95');
    expect(stats).toContain('548 / 2,120min / max');
    expect(stats).toContain('± 786jitter σ');
    // Browser median of 612 and 2184 — reported apart, never mixed in.
    expect(flat(container)).toContain('audible a median of 1,398 ms after the final transcript');
    expect(screen.getByText('Median per leg')).toBeTruthy();
    expect(container.querySelectorAll('.leg-bar-fill')).toHaveLength(3);
    // TTS: median(186, 1758) = 972 is slowest.
    expect(flat(container.querySelector('.verdict')!)).toContain('TTS TTFB is the slowest leg at 972 ms median. Swap it first.');
  });

  it('with only one leg measured it says there is nothing slower to single out', () => {
    const one: TurnRecord = { ...pipelineTurn, derived: { timeToFirstAudioMs: 500, sttLatencyMs: 200 }, clientTtfaMs: undefined };
    const { container } = render(<InsightsPanel turns={[one]} />);
    expect(flat(container.querySelector('.verdict')!)).toContain('Only STT was measured (200 ms median)');
    expect(screen.queryByText(/after the final transcript/)).toBeNull();
  });

  it('a pipeline turn with no leg timings says there is nothing to split', () => {
    render(<InsightsPanel turns={[{ ...pipelineTurn, derived: { timeToFirstAudioMs: 500 } }]} />);
    expect(screen.getByText('No leg was timed on its own, so there is nothing to split.')).toBeTruthy();
  });

  it('realtime: never splits or ranks the transcript, but reports when it arrived', () => {
    const { container } = render(<InsightsPanel turns={[realtimeTurn]} mode="realtime" />);
    expect(container.querySelector('.hero-v')?.textContent).toBe('441');
    expect(container.querySelector('.leg-bar-fill')).toBeNull();
    expect(container.querySelector('.verdict')).toBeNull();
    expect(flat(container)).toContain('nothing to split: a realtime model answers straight from your audio.');
    expect(flat(container)).toContain('Its transcript of your speech arrived at 620 ms (median).');
  });
});

describe('CostPanel', () => {
  it('says nothing was consumed with no usage', () => {
    render(<CostPanel usage={[]} />);
    expect(screen.getByText('No turn completed, so nothing was consumed.')).toBeTruthy();
  });

  it('shows per turn, totals, the 10k projection, the recovered FX rate and token counts', () => {
    const { container } = render(<CostPanel usage={SYNTHETIC.turns} />);
    expect(container.querySelector('.hero-v')?.textContent).toBe('$0.0021');
    expect(flat(container.querySelector('dl')!)).toContain('$0.0041 · 2 turns');
    expect(flat(container.querySelector('dl')!)).toContain('≈ $615 per month');
    // INR/USD ratio of the server's own totals.
    expect(screen.getByText('₹88.49 / $1, assumed')).toBeTruthy();
    expect(screen.getByText('~1,650')).toBeTruthy();
    expect(screen.getByText('Some counts are estimated locally, marked ~ in the usage table.')).toBeTruthy();
    expect(screen.getByText(/No rate on file for elevenlabs-tts:v3 — every figure above is a floor/)).toBeTruthy();
  });

  it('omits the FX line when there is nothing to divide by, and tokens when there are none', () => {
    const usage = [{ turnId: 1, at: NOW, costUsd: 0, costInr: 0, unpriced: [],
      legs: [{ leg: 'tts' as const, providerId: 'p', modelId: 'm', unit: 'characters' as const, inputUnits: 0, outputUnits: 5, source: 'vendor' as const }] }];
    const { container } = render(<CostPanel usage={usage} />);
    expect(screen.queryByText(/\/ \$1, assumed/)).toBeNull();
    expect(screen.queryByText('LLM tokens')).toBeNull();
    expect(screen.queryByText(/estimated locally/)).toBeNull();
    expect(flat(container.querySelector('dl')!)).toContain('1 turn');
  });

  it('vendor-reported tokens are not marked estimated', () => {
    render(<CostPanel usage={[SYNTHETIC.turns[0]]} />);
    const dd = screen.getByText('700');
    expect(dd.className).toBe('');
  });

  it('Stat renders value, optional sub, and label', () => {
    const { container, rerender } = render(<Stat label="p95" value="1,403" />);
    expect(container.querySelector('.stat-sub')).toBeNull();
    rerender(<Stat label="p95" value="1,403" sub="ms" />);
    expect(flat(container)).toBe('1,403msp95');
  });
});
