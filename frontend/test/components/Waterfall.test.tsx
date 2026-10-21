// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LegBars, Waterfall, WaterfallAxis, WaterfallLegend, type WaterfallRow } from '../../src/components/Waterfall';
import { LEG_BANDS, bandsOf } from '../../src/lib/legs';
import { pipelineTurn } from './fixtures';

const row = (over: Partial<WaterfallRow> = {}): WaterfallRow => ({
  turnId: 1, bands: bandsOf(pipelineTurn.derived, pipelineTurn.marks), totalMs: 548, tailMs: 2740, ...over,
});

// jsdom normalises inline percentages, so `21.600%` reads back as `21.6%`.
describe('Waterfall', () => {
  it('positions each band where it ran against one shared scale', () => {
    const { container } = render(<Waterfall rows={[row()]} scaleMs={1000} />);
    const segs = [...container.querySelectorAll('.wf-seg')] as HTMLElement[];
    expect(segs.map((s) => s.className)).toEqual(['wf-seg lane-stt', 'wf-seg lane-llm', 'wf-seg lane-tts']);
    expect(segs.map((s) => s.style.left)).toEqual(['0%', '21.6%', '36.4%']);
    expect(segs.map((s) => s.style.width)).toEqual(['21.4%', '14.8%', '18.6%']);
    expect(segs[1].getAttribute('title')).toBe('LLM TTFT — 148 ms, starting 216 ms after t0');
    const mark = container.querySelector('.wf-mark') as HTMLElement;
    expect(mark.style.left).toBe('54.8%');
    // The tail starts at first audio and is clamped to the track.
    const tail = container.querySelector('.wf-tail') as HTMLElement;
    expect(tail.style.left).toBe('54.8%');
    expect(tail.style.width).toBe('100%');
    expect(tail.getAttribute('title')).toBe('reply plays out — 2.7s of audio');
    expect(container.querySelectorAll('.wf-grid-line')).toHaveLength(4);
    expect(screen.getByText('548 ms')).toBeTruthy();
  });

  it('a 0 ms band still gets a hairline so "instant" differs from "not measured"', () => {
    const { container } = render(
      <Waterfall rows={[row({ bands: [{ ...LEG_BANDS[0], startMs: 0, ms: 0 }], tailMs: undefined })]} scaleMs={1000} />,
    );
    expect((container.querySelector('.wf-seg') as HTMLElement).style.width).toBe('0.4%');
    expect(container.querySelector('.wf-tail')).toBeNull();
  });

  it('a turn with no bands and no first audio reads as no reply', () => {
    const { container } = render(<Waterfall rows={[row({ bands: [], totalMs: undefined })]} scaleMs={1000} />);
    expect(screen.getByText('No reply audio')).toBeTruthy();
    expect(container.querySelector('.wf-total')?.textContent).toBe('—');
  });

  it('flags the slowest of several turns, and any over 900 ms as slow', () => {
    const { container } = render(
      <Waterfall rows={[row({ turnId: 1, totalMs: 400 }), row({ turnId: 2, totalMs: 950 }), row({ turnId: 3, totalMs: 2000 })]} scaleMs={3000} />,
    );
    expect([...container.querySelectorAll('.wf-total')].map((t) => t.className)).toEqual([
      'wf-total ', 'wf-total slow', 'wf-total slowest',
    ]);
  });

  it('a single turn is never "slowest"', () => {
    const { container } = render(<Waterfall rows={[row({ totalMs: 2000 })]} scaleMs={3000} />);
    expect(container.querySelector('.wf-total')?.className).toBe('wf-total slow');
  });

  it('survives a zero scale without dividing by it', () => {
    const { container } = render(<Waterfall rows={[row()]} scaleMs={0} />);
    expect(container.textContent).not.toContain('NaN');
    expect((container.querySelector('.wf-mark') as HTMLElement).style.left).toBe('100%');
  });
});

describe('WaterfallAxis', () => {
  it('labels ticks in ms under a second and in s above', () => {
    const { container } = render(<WaterfallAxis scaleMs={2000} />);
    expect([...container.querySelectorAll('.wf-tick')].map((t) => t.textContent)).toEqual(['500 ms', '1.0 s', '1.5 s', '2.0 s']);
    expect(screen.getByText('t0 · you stopped')).toBeTruthy();
  });
});

describe('WaterfallLegend', () => {
  it('always names all three legs, first audio and reply', () => {
    render(<WaterfallLegend />);
    for (const label of ['STT', 'LLM to first token', 'TTS to first byte', 'First audio', 'Reply playing']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

describe('LegBars', () => {
  const legs = LEG_BANDS.map((b, i) => ({ key: b.key, name: b.name, color: b.color, ms: [200, 400, 800][i] }));

  it('says so when there are no legs', () => {
    render(<LegBars legs={[]} />);
    expect(screen.getByText('No per-leg timings recorded.')).toBeTruthy();
  });

  it('draws separate bars against the larger of scale and the longest leg', () => {
    const { container } = render(<LegBars legs={legs} scaleMs={400} />);
    const fills = [...container.querySelectorAll('.leg-bar-fill')] as HTMLElement[];
    expect(fills.map((f) => f.style.width)).toEqual(['25%', '50%', '100%']);
    expect(fills[2].getAttribute('title')).toBe('TTS TTFB — 800 ms median');
    expect([...container.querySelectorAll('.leg-bar-val')].map((v) => v.textContent)).toEqual(['200 ms', '400 ms', '800 ms']);
  });

  it('can draw bare bars without names or values', () => {
    const { container } = render(<LegBars legs={legs} showKeys={false} />);
    expect(container.querySelector('.leg-bars')?.className).toBe('leg-bars bare');
    expect(container.querySelector('.leg-bar-name')).toBeNull();
    expect(container.querySelector('.leg-bar-val')).toBeNull();
  });

  it('a tiny leg keeps a visible minimum width', () => {
    const { container } = render(<LegBars legs={[{ ...legs[0], ms: 0 }]} scaleMs={1000} />);
    expect((container.querySelector('.leg-bar-fill') as HTMLElement).style.width).toBe('0.6%');
  });
});
