// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LegTotals, UsagePanel, billedCurrency } from '../../src/components/UsagePanel';
import type { LegUsage, TurnUsage } from '../../src/lib/protocol';
import { NOW, SYNTHETIC, realtimeSecondsUsage } from './fixtures';

const rows = (c: HTMLElement) => [...c.querySelectorAll('tbody tr')] as HTMLTableRowElement[];
const cells = (r: HTMLTableRowElement) => [...r.querySelectorAll('td')].map((td) => (td.textContent ?? '').trim());

describe('UsagePanel', () => {
  it('says nothing was consumed when no turn completed, with a heading unless compact', () => {
    const { unmount } = render(<UsagePanel usage={[]} />);
    expect(screen.getByRole('heading', { name: /Tokens & cost/ })).toBeTruthy();
    expect(screen.getByText('No turn completed, so nothing was consumed.')).toBeTruthy();
    unmount();
    render(<UsagePanel usage={[]} compact />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('No turn completed, so nothing was consumed.')).toBeTruthy();
  });

  it('pipeline: summary stats, one row per turn in each leg unit, estimated marks', () => {
    const { container } = render(<UsagePanel usage={SYNTHETIC.turns} />);
    expect(screen.getByText('Estimated cost so far')).toBeTruthy();
    expect(screen.getByText('$0.0041')).toBeTruthy();
    // Turn 2's LLM leg is local, so the token total is flagged.
    expect(screen.getByText('LLM tokens (some estimated)')).toBeTruthy();
    expect(screen.getByText('1,650')).toBeTruthy();
    expect(screen.getByText('Per turn (avg)')).toBeTruthy();
    expect([...container.querySelectorAll('thead th')].map((t) => t.textContent)).toEqual([
      'Turn', 'STT audio', 'LLM in', 'LLM out', 'TTS chars', 'USD', 'INR',
    ]);
    const [r1, r2] = rows(container);
    expect(cells(r1)).toEqual(['1', '~3.2 s', '520', '180140 thinking', '~1405.1 s audio', '$0.0019', '₹0.17']);
    expect(cells(r2)[2]).toBe('~720');
    expect(r2.querySelectorAll('td')[2].getAttribute('title')).toMatch(/Estimated from character count/);
    expect(r1.querySelectorAll('td')[2].getAttribute('title')).toBe('Vendor-reported');
    // Unpriced leg on turn 2 makes the total a floor.
    expect(screen.getByText('No rate on file for elevenlabs-tts:v3 — the total above is a floor, not a bill.')).toBeTruthy();
  });

  it('compact drops the heading and the summary but keeps the rows', () => {
    const { container } = render(<UsagePanel usage={SYNTHETIC.turns} compact />);
    expect(screen.queryByText('Estimated cost so far')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(rows(container)).toHaveLength(2);
  });

  it('marks a silent turn and an STT-only tail', () => {
    const stt = SYNTHETIC.turns[0].legs[0];
    const usage: TurnUsage[] = [
      SYNTHETIC.turns[0],
      { ...SYNTHETIC.turns[1], legs: SYNTHETIC.turns[1].legs.map((l) => (l.leg === 'tts' ? { ...l, outputUnits: 0 } : l)) },
      { turnId: 3, at: NOW, costUsd: 0.0001, costInr: 0.01, unpriced: [], legs: [{ ...stt, inputUnits: 1.8 }] },
    ];
    const { container } = render(<UsagePanel usage={usage} compact />);
    const [r1, r2, r3] = rows(container);
    expect(r1.className).toBe('');
    expect(r2.className).toBe('row-silent');
    expect(r2.textContent).toContain('no reply');
    expect(r3.className).toBe('row-tail');
    expect(r3.textContent).toContain('Tail · after last turn');
    expect(screen.getAllByText('no reply')).toHaveLength(1);
    // A tail has no LLM or TTS leg to show.
    expect(cells(r3).slice(2, 5)).toEqual(['—', '—', '—']);
  });

  it('realtime (seconds-metered) uses the realtime table and the vendor unit', () => {
    const { container } = render(<UsagePanel usage={realtimeSecondsUsage} />);
    expect([...container.querySelectorAll('thead th')].map((t) => t.textContent)).toEqual([
      'Turn', 'Model', 'In', 'Out', 'Audio', 'USD', 'INR',
    ]);
    expect(cells(rows(container)[0])).toEqual(['1', 'mock-s2s', '~2 s audio', '~4 s audio', '—', '$0', '₹0']);
    // No LLM leg, so no token stat.
    expect(screen.queryByText(/LLM tokens/)).toBeNull();
  });

  it('realtime (token-metered) never wears a seconds suffix on a token count', () => {
    const usage: TurnUsage[] = [{
      turnId: 1, at: NOW, costUsd: 0.0572, costInr: 5.4, unpriced: [],
      legs: [{ leg: 'realtime', providerId: 'openai-realtime', modelId: 'gpt-realtime-2.1', unit: 'tokens',
        inputUnits: 132, outputUnits: 121, audioInputTokens: 13, audioOutputTokens: 91, cachedInputTokens: 64,
        audioSeconds: 5.2, source: 'vendor' }],
    }];
    const { container } = render(<UsagePanel usage={usage} compact />);
    expect(cells(rows(container)[0])).toEqual(['1', 'gpt-realtime-2.1', '132 tokens13 audio · 64 cached', '121 tokens91 audio', '5.2s', '$0.06', '₹5.40']);
  });

  it('realtime turn that produced nothing is flagged', () => {
    const usage: TurnUsage[] = [{ ...realtimeSecondsUsage[0], legs: [{ ...realtimeSecondsUsage[0].legs[0], outputUnits: 0 }] }];
    const { container } = render(<UsagePanel usage={usage} compact />);
    expect(rows(container)[0].className).toBe('row-silent');
  });
});

describe('LegTotals', () => {
  it('shows units, rates, ambiguous flags, and dims per vendor currency', () => {
    const { container } = render(<LegTotals legs={SYNTHETIC.totals} />);
    const [stt, llm, tts, el] = rows(container);
    expect(cells(stt)).toEqual(['STT', 'sarvam-sttsaaras:v3-realtime@fast', '~7.4 s audio', '—', '₹30 per hour of audio', '$0.00070', '₹0.06']);
    expect(cells(llm)[2]).toBe('1,240 tokens900 cached');
    expect(cells(llm)[3]).toBe('410 tokens302 thinking');
    expect(llm.querySelectorAll('td')[5].className).toBe('strong');
    expect(llm.querySelectorAll('td')[6].className).toBe('muted');
    expect(tts.querySelector('.rate-flag')?.getAttribute('title')).toBe('Murf markets Falcon at "1 cent per minute" instead.');
    expect(cells(tts)[3]).toBe('~296 chars11.2 s audio');
    expect(el.querySelector('td.rate')?.className).toBe('left rate unrated');
    expect(el.querySelector('td.rate')?.getAttribute('title')).toBe('No rate on file for elevenlabs-tts:v3');
    expect(cells(el).slice(5)).toEqual(['—', '—']);
    expect(container.querySelector('.row-total')).toBeNull();
  });

  it('names providers through nameOf and closes with the ledger total', () => {
    const { container } = render(
      <LegTotals legs={SYNTHETIC.totals} nameOf={(id) => (id === 'murf-tts' ? 'Murf Falcon' : undefined)} total={{ usd: 0.0041, inr: 0.3628, floor: true }} />,
    );
    expect(screen.getByText('Murf Falcon')).toBeTruthy();
    const total = container.querySelector('.row-total')!;
    expect(total.textContent).toContain('Total');
    expect(total.querySelector('.pill.floor')).toBeTruthy();
    expect(total.textContent).toContain('$0.0041');
    expect(total.textContent).toContain('₹0.36');
  });

  it('a realtime leg has no band swatch colour and reads "Realtime"', () => {
    const leg: LegUsage = { leg: 'realtime', providerId: 'p', modelId: 'm', unit: 'tokens', inputUnits: 1, outputUnits: 1, source: 'vendor' };
    const { container } = render(<LegTotals legs={[leg]} />);
    expect(container.querySelector('.leg-key')?.textContent).toBe('Realtime');
    expect((container.querySelector('.leg-swatch') as HTMLElement).style.background).toBe('');
  });
});

describe('billedCurrency', () => {
  it('is the one currency every priced leg bills in, else undefined', () => {
    expect(billedCurrency(SYNTHETIC.totals)).toBeUndefined();
    expect(billedCurrency([SYNTHETIC.totals[1], SYNTHETIC.totals[2]])).toBe('USD');
    expect(billedCurrency([SYNTHETIC.totals[0]])).toBe('INR');
    expect(billedCurrency([SYNTHETIC.totals[3]])).toBeUndefined();
    expect(billedCurrency([])).toBeUndefined();
  });
});
