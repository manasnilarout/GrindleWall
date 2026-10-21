// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RunDetailView } from '../../src/components/RunDetailView';
import { REALTIME_SUMMARY, SYNTHETIC, namedProviders } from './fixtures';

vi.mock('../../src/lib/download', () => ({ downloadJson: vi.fn() }));
const { downloadJson } = await import('../../src/lib/download');

const props = (over: Partial<Parameters<typeof RunDetailView>[0]> = {}) => ({
  summary: SYNTHETIC,
  justEnded: true,
  providers: namedProviders,
  onBackToRuns: vi.fn(),
  onBackToBench: vi.fn(),
  ...over,
});

describe('RunDetailView', () => {
  it('heads a just-ended run with the readable chain, raw label and the filed eyebrow', () => {
    render(<RunDetailView {...props()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sarvam Saaras → Google Gemini → Murf Falcon');
    expect(screen.getByText(SYNTHETIC.label)).toBeTruthy();
    expect(screen.getByText('Mischief managed · filed to disk')).toBeTruthy();
    expect(screen.getByText('1m 02s · 2 turns')).toBeTruthy();
    // The report body names itself for a just-ended run.
    expect(screen.getByRole('region', { name: 'Conversation report' })).toBeTruthy();
  });

  it('does not claim a run with no turns was filed', () => {
    render(<RunDetailView {...props({ summary: { ...SYNTHETIC, turnCount: 0 } })} />);
    expect(screen.getByText('No turns ran · nothing was filed')).toBeTruthy();
    expect(screen.queryByText(/filed to disk/)).toBeNull();
  });

  it('an archived record has no eyebrow, is titled Past conversation, and falls back to ids without a catalog', () => {
    render(<RunDetailView {...props({ justEnded: false, providers: undefined })} />);
    expect(screen.queryByText(/Mischief managed/)).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('sarvam-stt → google-llm → murf-tts');
    expect(screen.getByRole('region', { name: 'Past conversation' })).toBeTruthy();
  });

  it('reads the chain from the config ids when present, and a realtime run is one provider', () => {
    render(<RunDetailView {...props({ summary: REALTIME_SUMMARY })} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('OpenAI Realtime');
  });

  it('falls back to "Conversation" when there is neither config nor label to name', () => {
    render(<RunDetailView {...props({ summary: { ...SYNTHETIC, label: '' } })} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Conversation');
  });

  it('meta line carries a single language, or the in/out pair, and a shortened long voice id', () => {
    const { unmount } = render(
      <RunDetailView {...props({ summary: { ...SYNTHETIC, config: { ...SYNTHETIC.config, language: 'hi-IN', voice: 'priya' } } })} />,
    );
    expect(screen.getByText(/· language hi-IN/)).toBeTruthy();
    expect(screen.getByText('voice priya').getAttribute('title')).toBe('priya');
    unmount();

    const voice = 'a0e99841-438c-4a64-b679-ae501e7d6091';
    render(
      <RunDetailView
        {...props({ summary: { ...SYNTHETIC, turnCount: 1, config: { ...SYNTHETIC.config, ttsLanguage: 'hi-IN', voice } } })}
      />,
    );
    expect(screen.getByText(/1 turn · language auto in, hi-IN out/)).toBeTruthy();
    const v = screen.getByText('voice a0e99841…');
    expect(v.getAttribute('title')).toBe(voice);
  });

  it('crumb goes back to Runs, the primary action back to the bench', () => {
    const p = props();
    render(<RunDetailView {...p} />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Runs' }));
    expect(p.onBackToRuns).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back to bench' }));
    expect(p.onBackToBench).toHaveBeenCalledTimes(1);
  });

  it('exports the whole record as JSON named for its record id', () => {
    render(<RunDetailView {...props()} />);
    const btn = screen.getByRole('button', { name: /Export JSON/ });
    expect(btn.getAttribute('title')).toBe('The whole record, as synthetic.json');
    fireEvent.click(btn);
    expect(downloadJson).toHaveBeenCalledWith(SYNTHETIC, 'session-synthetic.json');
  });
});
