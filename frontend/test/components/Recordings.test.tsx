// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Recordings, SeriesBadge } from '../../src/components/Recordings';
import { normalizeSummary } from '../../src/lib/session';
import { AUTH_STORAGE_KEY } from '../../src/lib/auth';
import { RIG_COLORS } from '../../src/lib/rigs';
import { NOW, SYNTHETIC } from './fixtures';

const run = (id: string, label: string) => normalizeSummary({ ...SYNTHETIC, recordId: id, sessionId: `socket-${id}`, label });
const two = [run('rec-a', 'cartesia-tts:sonic-3.6'), run('rec-b', 'elevenlabs-tts:eleven_flash_v2_5')];

/** Fires the media element's error with a given MediaError code. */
function failWith(audio: HTMLAudioElement, code: number) {
  Object.defineProperty(audio, 'error', { configurable: true, value: { code } });
  fireEvent.error(audio);
}

describe('Recordings', () => {
  afterEach(() => localStorage.clear());

  it('renders nothing for an empty selection', () => {
    const { container } = render(<Recordings runs={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('gives each run its own player, pointed at its record id and never the socket id', () => {
    render(<Recordings runs={two} />);
    expect(screen.getByRole('heading', { name: /Recordings/ })).toBeTruthy();
    expect(screen.getByText('left: mic · right: assistant')).toBeTruthy();
    const a = screen.getByLabelText('Recording of cartesia-tts:sonic-3.6') as HTMLAudioElement;
    const b = screen.getByLabelText('Recording of elevenlabs-tts:eleven_flash_v2_5') as HTMLAudioElement;
    expect(a.getAttribute('src')).toBe('/api/sessions/rec-a/audio');
    expect(b.getAttribute('src')).toBe('/api/sessions/rec-b/audio');
    expect(a.getAttribute('preload')).toBe('metadata');
    expect(a.hasAttribute('controls')).toBe(true);
  });

  it('appends the session token so a gated backend serves the file', () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'tok/1', username: 'u', expiresAt: NOW * 10 }));
    render(<Recordings runs={[two[0]]} />);
    expect(screen.getByLabelText(/Recording of/).getAttribute('src')).toBe('/api/sessions/rec-a/audio?token=tok%2F1');
  });

  it('shows the series badge and readable name when the run is in the comparison', () => {
    const { container } = render(
      <Recordings runs={two} series={{ 'rec-a': { n: 1, color: RIG_COLORS[0], name: 'Cartesia Sonic' } }} />,
    );
    const badge = container.querySelector('.series-badge.sm') as HTMLElement;
    expect(badge.textContent).toBe('1');
    expect(badge.style.background).toBeTruthy();
    expect(screen.getByText('Cartesia Sonic').getAttribute('title')).toBe('cartesia-tts:sonic-3.6');
    expect(screen.getByLabelText('Recording of Cartesia Sonic')).toBeTruthy();
  });

  it('marks a 404 (MEDIA_ERR_SRC_NOT_SUPPORTED) as no recording, keeping the panel for the other run', () => {
    render(<Recordings runs={two} />);
    failWith(screen.getByLabelText('Recording of cartesia-tts:sonic-3.6') as HTMLAudioElement, 4);
    expect(screen.getByText('No recording on disk for this run.')).toBeTruthy();
    expect(screen.getByLabelText('Recording of elevenlabs-tts:eleven_flash_v2_5')).toBeTruthy();
  });

  it('says a load failed rather than claiming absence for any other media error', () => {
    render(<Recordings runs={[two[0]]} />);
    failWith(screen.getByLabelText(/Recording of/) as HTMLAudioElement, 2);
    expect(screen.getByText('Could not load the recording.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Recordings/ })).toBeTruthy();
  });

  it('hides the whole panel once every run is known to have no recording', () => {
    const { container } = render(<Recordings runs={two} />);
    for (const audio of [...container.querySelectorAll('audio')]) failWith(audio as HTMLAudioElement, 4);
    expect(container.innerHTML).toBe('');
  });

  it('forgets missing recordings when the selection changes, so a late WAV can load', () => {
    const { container, rerender } = render(<Recordings runs={[two[0]]} />);
    failWith(container.querySelector('audio') as HTMLAudioElement, 4);
    expect(container.innerHTML).toBe('');
    rerender(<Recordings runs={two} />);
    expect(container.querySelectorAll('audio')).toHaveLength(2);
  });

  it('SeriesBadge draws the number, small when asked, hidden from assistive tech', () => {
    const { container } = render(<SeriesBadge tag={{ n: 3, color: '#123456', name: 'x' }} />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toBe('series-badge');
    expect(badge.textContent).toBe('3');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.style.background).toBe('rgb(18, 52, 86)');
  });
});
