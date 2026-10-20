// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SessionReport } from '../../src/components/SessionReport';
import { normalizeSummary } from '../../src/lib/session';
import type { SessionSummary } from '../../src/lib/protocol';
import { REALTIME_SUMMARY, SYNTHETIC, namedProviders } from './fixtures';

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('SessionReport', () => {
  it('labels its region and shows the headline cards', () => {
    render(<SessionReport summary={SYNTHETIC} />);
    expect(screen.getByRole('region', { name: 'Conversation report' })).toBeTruthy();
    const cards = screen.getByRole('group', { name: 'Headline numbers' });
    expect(text(cards)).toContain('Total, 2 turns');
    expect(text(cards)).toContain('First audio, median812 ms');
    expect(text(cards)).toContain('p951,403 ms');
    expect(text(cards)).toContain('min 640 · max 1,403');
    expect(text(cards)).toContain('Reply length, median2.7 s');
  });

  it('uses a custom title for archived records', () => {
    render(<SessionReport summary={SYNTHETIC} title="Past conversation" />);
    expect(screen.getByRole('region', { name: 'Past conversation' })).toBeTruthy();
  });

  it('marks every total as a floor when a leg is unpriced', () => {
    const { container } = render(<SessionReport summary={SYNTHETIC} />);
    expect(screen.getByText(/No rate on file for elevenlabs-tts:v3 — every total here is a floor, not a bill\./)).toBeTruthy();
    expect(container.querySelectorAll('.pill.floor').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('no rate on file')).toBeTruthy();
  });

  it('a fully priced record carries no floor flag', () => {
    const priced: SessionSummary = {
      ...SYNTHETIC, unpriced: [], totals: SYNTHETIC.totals.slice(0, 3), turns: SYNTHETIC.turns.map((t) => ({ ...t, unpriced: [] })),
    };
    const { container } = render(<SessionReport summary={priced} />);
    expect(container.querySelector('.pill.floor')).toBeNull();
    expect(screen.queryByText(/floor, not a bill/)).toBeNull();
  });

  it('leads with USD when vendors disagree on currency, and with INR when they all bill rupees', () => {
    const { container, unmount } = render(<SessionReport summary={SYNTHETIC} />);
    const total = container.querySelector('.report-stat .report-stat-value');
    expect(text(total)).toBe('$0.0041');
    expect(container.querySelector('.report-stat .report-stat-sub')?.getAttribute('title')).toMatch(/part quoted and part converted/);
    unmount();

    const rupees: SessionSummary = { ...SYNTHETIC, unpriced: [], totals: [SYNTHETIC.totals[0]] };
    const { container: c2 } = render(<SessionReport summary={rupees} />);
    expect(text(c2.querySelector('.report-stat .report-stat-value'))).toBe('₹0.36');
    expect(c2.querySelector('.report-stat .report-stat-sub')?.getAttribute('title')).toBe('Converted at the assumed FX rate');
  });

  it('dims the converted currency per leg, following the vendor', () => {
    render(<SessionReport summary={SYNTHETIC} />);
    const row = screen.getByText('saaras:v3-realtime@fast', { selector: '.legs-table .cell-sub' }).closest('tr')!;
    const cells = row.querySelectorAll('td');
    const usdCell = cells[5];
    const inrCell = cells[6];
    expect(usdCell.className).toBe('muted');
    expect(inrCell.className).toBe('strong');
    expect(inrCell.getAttribute('title')).toBe("Billed in INR — this is the vendor's own figure");
    expect(usdCell.getAttribute('title')).toBe('Converted from INR at the assumed FX rate');
  });

  it('uses provider display names in the cost table when the catalog is given', () => {
    render(<SessionReport summary={SYNTHETIC} providers={namedProviders} />);
    expect(screen.getByText('Murf Falcon')).toBeTruthy();
    // Unnamed providers fall back to their id.
    expect(screen.getByText('elevenlabs-tts')).toBeTruthy();
  });

  it('offers the recording by record id with a download, and retries after a missing file', () => {
    render(<SessionReport summary={{ ...SYNTHETIC, recordId: 'rec-1', sessionId: 'sock-1' }} />);
    const audio = screen.getByLabelText('Recording of this conversation') as HTMLAudioElement;
    expect(audio.getAttribute('src')).toBe('/api/sessions/rec-1/audio');
    const dl = screen.getByRole('link', { name: /Download WAV/ });
    expect(dl.getAttribute('href')).toBe('/api/sessions/rec-1/audio');
    expect(dl.getAttribute('download')).toBe('rec-1.wav');

    fireEvent.error(audio);
    expect(screen.getByText(/No recording for this conversation/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Download WAV/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const again = screen.getByLabelText('Recording of this conversation');
    expect(again).not.toBe(audio);
    expect(screen.getByRole('link', { name: /Download WAV/ })).toBeTruthy();
  });

  it('a new record resets the missing-recording state', () => {
    const { rerender } = render(<SessionReport summary={{ ...SYNTHETIC, recordId: 'r1' }} />);
    fireEvent.error(screen.getByLabelText('Recording of this conversation'));
    expect(screen.getByText(/No recording for this conversation/)).toBeTruthy();
    rerender(<SessionReport summary={{ ...SYNTHETIC, recordId: 'r2' }} />);
    expect(screen.getByLabelText('Recording of this conversation').getAttribute('src')).toBe('/api/sessions/r2/audio');
  });

  it('offers no recording for a record with no completed turn', () => {
    const { container } = render(<SessionReport summary={{ ...SYNTHETIC, turnCount: 0 }} />);
    expect(container.querySelector('audio')).toBeNull();
    expect(screen.queryByText(/saved server-side as/)).toBeNull();
  });

  it('projects the monthly cost at the chosen volume', () => {
    render(<SessionReport summary={SYNTHETIC} />);
    const group = screen.getByRole('group', { name: 'Turns a day' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['1k', '10k', '100k', '1M']);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    // $0.00205 per turn × 10k × 30
    expect(screen.getByText('≈ $615')).toBeTruthy();
    fireEvent.click(buttons[3]);
    expect(buttons[3].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('≈ $61,500')).toBeTruthy();
    // ₹0.1814 per turn × 1M × 30 = ₹54.42 lakh
    expect(screen.getByText('≈ ₹54.42 lakh / month')).toBeTruthy();
    fireEvent.click(buttons[0]);
    // 61.5 a month rounds to whole dollars above $10.
    expect(screen.getByText('≈ $62')).toBeTruthy();
    expect(screen.getByText('≈ ₹5,442 / month')).toBeTruthy();
  });

  it('shows the system prompt it ran with, or says none was recorded', () => {
    const { unmount } = render(<SessionReport summary={{ ...SYNTHETIC, config: { ...SYNTHETIC.config, systemPrompt: 'Answer briefly.' } }} />);
    expect(screen.getByText('Answer briefly.')).toBeTruthy();
    unmount();
    render(<SessionReport summary={SYNTHETIC} />);
    expect(screen.getByText('No system prompt recorded.')).toBeTruthy();
  });

  it('the trust table lists one row per leg and names locally counted legs', () => {
    const { container } = render(<SessionReport summary={SYNTHETIC} />);
    const trust = container.querySelector('.report-trust')!;
    expect(trust.querySelectorAll('.pill.vendor')).toHaveLength(1);
    expect(trust.querySelectorAll('.pill.local')).toHaveLength(3);
    expect(screen.getByText(/STT and TTS and TTS are counted in this process/)).toBeTruthy();
    expect(text(trust)).toContain('assumed ₹88.50');
  });

  it('the raw record disclosure holds the JSON as filed', () => {
    const { container } = render(<SessionReport summary={SYNTHETIC} />);
    const json = container.querySelector('.jsonbox')!;
    expect(JSON.parse(json.textContent!)).toEqual(SYNTHETIC);
    expect(screen.getByText('synthetic.json')).toBeTruthy();
  });

  it('renders Dismiss only with a handler, and calls it', () => {
    const { unmount } = render(<SessionReport summary={SYNTHETIC} />);
    expect(screen.queryByRole('button', { name: /Dismiss/ })).toBeNull();
    unmount();
    const onDismiss = vi.fn();
    render(<SessionReport summary={SYNTHETIC} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a realtime record renders its one leg and no per-leg timings', () => {
    render(<SessionReport summary={REALTIME_SUMMARY} />);
    expect(screen.getByText('Realtime')).toBeTruthy();
    expect(screen.getAllByText('132 tokens').length).toBeGreaterThan(0);
    expect(screen.getByText('91 audio')).toBeTruthy();
    expect(screen.getByText('No per-leg timings recorded.')).toBeTruthy();
  });

  it.each([
    ['an empty object', {}],
    ['no totals', { ...SYNTHETIC, totals: undefined }],
    ['no turns', { ...SYNTHETIC, turns: undefined }],
    ['no latency', { ...SYNTHETIC, latency: undefined }],
    ['no usdPerInr', { ...SYNTHETIC, usdPerInr: undefined }],
  ])('survives a normalised record with %s and never prints NaN', (_, raw) => {
    const { container } = render(<SessionReport summary={normalizeSummary(raw)} />);
    expect(screen.getByText('Cost by leg')).toBeTruthy();
    expect(container.textContent).not.toContain('NaN');
  });
});
