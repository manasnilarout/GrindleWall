// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Console } from '../../src/components/Console';
import type { LogLine } from '../../src/hooks/useVoiceSession';
import { NOW, logs } from './fixtures';

const lines = (c: HTMLElement) => [...c.querySelectorAll('.log-line')] as HTMLButtonElement[];
const messages = (c: HTMLElement) => lines(c).map((l) => l.querySelector('.log-msg')?.textContent);

describe('Console', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    // jsdom does not implement scrollIntoView; the console calls it to follow the tail.
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  describe('docked', () => {
    it('is one bar with attention counts, the newest line, and a way in', () => {
      const onToggle = vi.fn();
      const { container } = render(<Console logs={logs} expanded={false} onToggleExpand={onToggle} />);
      expect(screen.getByRole('region', { name: 'Console' })).toBeTruthy();
      expect(screen.getByText('1 warning')).toBeTruthy();
      expect(screen.getByText('1 error')).toBeTruthy();
      const latest = container.querySelector('.console-latest')!;
      expect(latest.textContent).toBe('#4  tts  tts_request_sent  t+364 ms');
      expect(latest.className).toBe('console-latest mono info');
      expect(latest.getAttribute('title')).toBe('tts_request_sent');
      const toggle = screen.getByRole('button', { name: /Open/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.hasAttribute('aria-controls')).toBe(false);
      fireEvent.click(toggle);
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(container.querySelector('.log-line')).toBeNull();
    });

    it('pluralises counts and says it is quiet when empty', () => {
      const many: LogLine[] = [logs[1], logs[1], logs[2], logs[2], logs[2]];
      const { rerender } = render(<Console logs={many} expanded={false} onToggleExpand={() => {}} />);
      expect(screen.getByText('2 warnings')).toBeTruthy();
      expect(screen.getByText('3 errors')).toBeTruthy();
      rerender(<Console logs={[]} expanded={false} onToggleExpand={() => {}} />);
      expect(screen.getByText('Quiet. Connect a session.')).toBeTruthy();
      expect(screen.queryByText(/warning/)).toBeNull();
    });
  });

  describe('expanded', () => {
    const open = (l: LogLine[] = logs) => render(<Console logs={l} expanded onToggleExpand={() => {}} />);

    it('lists every line as a button, with level counts and a Close toggle wired to the panel', () => {
      const { container } = open();
      expect(lines(container)).toHaveLength(4);
      expect(screen.getByRole('button', { name: 'info 2' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: 'warn 1' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'error 1' })).toBeTruthy();
      const toggle = screen.getByRole('button', { name: /Close/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-controls')).toBe('console-panel');
      expect(container.querySelector('#console-panel')).toBeTruthy();
      expect(screen.getByText('4 of 4', { exact: false })).toBeTruthy();
      // The mark line is highlighted and carries its turn.
      const mark = lines(container)[3];
      expect(mark.className).toBe('log-line info mark');
      expect(mark.querySelector('.log-turn')?.textContent).toBe('#4');
      expect(mark.querySelector('.log-lv')?.textContent).toBe('·');
      expect(lines(container)[1].querySelector('.log-lv')?.textContent).toBe('▲');
      expect(lines(container)[2].querySelector('.log-lv')?.textContent).toBe('✕');
    });

    it('toggling a level hides its lines and flips its pressed state', () => {
      const { container } = open();
      const info = screen.getByRole('button', { name: 'info 2' });
      fireEvent.click(info);
      expect(info.getAttribute('aria-pressed')).toBe('false');
      expect(info.getAttribute('title')).toBe('Show info lines');
      expect(messages(container)).toEqual(['turn 3 abandoned — banked audio handed to turn 4', 'no rate on file for groq-llm']);
      expect(screen.getByText('2 of 4', { exact: false })).toBeTruthy();
      fireEvent.click(info);
      expect(lines(container)).toHaveLength(4);
    });

    it('filters by message text or by source name, case-insensitively', () => {
      const { container } = open();
      const search = screen.getByLabelText('Filter console lines');
      fireEvent.change(search, { target: { value: 'GROQ' } });
      expect(messages(container)).toEqual(['no rate on file for groq-llm']);
      fireEvent.change(search, { target: { value: 'tts' } });
      expect(messages(container)).toEqual(['tts_request_sent']);
      fireEvent.change(search, { target: { value: 'llm' } });
      expect(messages(container)).toEqual(['no rate on file for groq-llm']);
      fireEvent.change(search, { target: { value: 'nothing like this' } });
      expect(screen.getByText('Nothing matches those filters.')).toBeTruthy();
    });

    it('the source rail counts by source and mutes one with a click', () => {
      const { container } = open();
      const rail = container.querySelector('.console-rail') as HTMLElement;
      const rows = within(rail).getAllByRole('button');
      // Sorted by count: session (2) first.
      expect(rows.map((r) => r.textContent)).toEqual(['session2', 'llm1', 'tts1']);
      fireEvent.click(rows[0]);
      expect(rows[0].getAttribute('aria-pressed')).toBe('false');
      expect(rows[0].className).toBe('src-row off');
      expect(messages(container)).toEqual(['no rate on file for groq-llm', 'tts_request_sent']);
      expect(within(rail).getByText('guessed')).toBeTruthy();
    });

    it('switches between wall clock and t+ from turn', () => {
      const { container } = open();
      const times = () => lines(container).map((l) => l.querySelector('.log-time')?.textContent);
      expect(times()[0]).toBe(new Date(NOW).toLocaleTimeString());
      fireEvent.click(screen.getByRole('button', { name: 't+ from turn' }));
      expect(times()).toEqual(['—', '—', '—', 't+364']);
      fireEvent.click(screen.getByRole('button', { name: 'wall clock' }));
      expect(times()[3]).toBe(new Date(NOW + 3).toLocaleTimeString());
    });

    it('expands a line with detail, and collapses it again', () => {
      const { container } = open();
      const mark = lines(container)[3];
      expect(mark.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(mark);
      expect(mark.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('.log-detail')?.textContent).toBe('marked before open() — the handshake is inside the window');
      fireEvent.click(mark);
      expect(container.querySelector('.log-detail')).toBeNull();
    });

    it('a long line with no detail expands to its own message; a short one shows nothing extra', () => {
      const long: LogLine = { at: NOW, level: 'info', message: 'x'.repeat(120), kind: 'log', source: 'session' };
      const { container } = open([logs[0], long]);
      fireEvent.click(lines(container)[0]);
      expect(container.querySelector('.log-detail')).toBeNull();
      fireEvent.click(lines(container)[1]);
      expect(container.querySelector('.log-detail')?.textContent).toBe('x'.repeat(120));
    });

    it('the open line follows the line itself, not its position, across a filter change', () => {
      const { container } = open();
      fireEvent.click(lines(container)[3]);
      fireEvent.click(screen.getByRole('button', { name: 'info 2' }));
      // The mark is info, so it is hidden; no other line inherits its detail.
      expect(container.querySelector('.log-detail')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^info/ }));
      expect(container.querySelector('.log-detail')).toBeTruthy();
    });

    it('follows the tail, and stops when paused', () => {
      const { rerender } = open();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end' });
      const follow = screen.getByRole('button', { name: '● following' });
      expect(follow.getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(follow);
      expect(screen.getByRole('button', { name: 'paused' }).getAttribute('aria-pressed')).toBe('false');
      scrollIntoView.mockClear();
      rerender(<Console logs={[...logs, logs[0]]} expanded onToggleExpand={() => {}} />);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('copies only the filtered lines', () => {
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      open();
      fireEvent.change(screen.getByLabelText('Filter console lines'), { target: { value: 'groq' } });
      fireEvent.click(screen.getByRole('button', { name: /^Copy$/ }));
      expect(writeText).toHaveBeenCalledExactlyOnceWith(`${new Date(NOW + 2).toISOString()} error llm no rate on file for groq-llm`);
    });

    it('copy is a no-op where the clipboard API is missing', () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
      open();
      expect(() => fireEvent.click(screen.getByRole('button', { name: /^Copy$/ }))).not.toThrow();
    });

    it('says it is quiet with no lines at all', () => {
      open([]);
      expect(screen.getByText('Quiet. Connect a session.')).toBeTruthy();
      expect(screen.getByText('0 of 0', { exact: false })).toBeTruthy();
    });

    it('does not claim browser-origin lines were scrubbed', () => {
      const { container } = open();
      expect(container.textContent).not.toMatch(/Everything here was scrubbed/);
      expect(container.textContent).toContain('never went through it');
    });
  });
});
