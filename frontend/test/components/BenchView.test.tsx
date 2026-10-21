// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { BenchView, type TurnDetection, type VoiceSessionHandle } from '../../src/components/BenchView';
import { envCommandOf, type Rig } from '../../src/lib/rigs';
import { baseRig, makeSession, novaProviders, novaRig, pickerProviders, pipelineTurn, SYNTHETIC } from './fixtures';

type Props = Parameters<typeof BenchView>[0];

const baseProps = (over: Partial<Props> = {}): Props => ({
  rig: baseRig,
  providers: pickerProviders,
  session: makeSession(),
  systemPrompt: 'Be brief.',
  onSystemPromptChange: vi.fn(),
  turnDetection: 'server_vad',
  onTurnDetectionChange: vi.fn(),
  locked: false,
  canDelete: true,
  onConnect: vi.fn(),
  onEdit: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onCreateCode: vi.fn(),
  ...over,
});

/** Owns the rig name the way App does, so a rename is visible as it is typed. */
function RenameHarness({ onRename, locked = false }: { onRename: (n: string) => void; locked?: boolean }) {
  const [rig, setRig] = useState<Rig>(baseRig);
  return (
    <BenchView
      {...baseProps({ rig, locked })}
      onRename={(name) => {
        onRename(name);
        setRig((r) => ({ ...r, name }));
      }}
    />
  );
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const sessionBar = () => screen.getByRole('region', { name: 'Session controls' });

describe('BenchView', () => {
  beforeEach(() => {
    // jsdom has no scrollIntoView; nothing here calls it, but the panels must not trip on it either.
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  describe('header', () => {
    it('heads the page with the rig, its architecture, and its actions', () => {
      render(<BenchView {...baseProps()} />);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Rig A');
      expect(screen.getByText('Pipeline · STT → LLM → TTS')).toBeTruthy();
      expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Bench')).toBeTruthy();
      for (const name of ['Rename rig', /Copy CLI command/, /Export voice stack/, /Delete rig/, /Edit rig/]) {
        expect(button(name).disabled).toBe(false);
      }
    });

    it('a realtime rig says so', () => {
      render(<BenchView {...baseProps({ rig: novaRig, providers: novaProviders })} />);
      expect(screen.getByText('Realtime · speech to speech')).toBeTruthy();
    });

    it('Edit, Export and Delete fire their callbacks', () => {
      const p = baseProps();
      render(<BenchView {...p} />);
      fireEvent.click(button(/Edit rig/));
      fireEvent.click(button(/Export voice stack/));
      fireEvent.click(button(/Delete rig/));
      expect(p.onEdit).toHaveBeenCalledTimes(1);
      expect(p.onCreateCode).toHaveBeenCalledTimes(1);
      expect(p.onDelete).toHaveBeenCalledTimes(1);
    });

    it('offers no Delete for the last rig', () => {
      render(<BenchView {...baseProps({ canDelete: false })} />);
      expect(screen.queryByRole('button', { name: /Delete rig/ })).toBeNull();
    });

    it('locks rename, delete and edit while live, with the reason on hover', () => {
      render(<BenchView {...baseProps({ locked: true })} />);
      expect(button('Rename rig').disabled).toBe(true);
      expect(button('Rename rig').getAttribute('title')).toBe('End the conversation to edit this rig');
      expect(button(/Delete rig/).disabled).toBe(true);
      expect(button(/Delete rig/).getAttribute('title')).toBe('End the conversation to delete this rig');
      expect(button(/Edit rig/).disabled).toBe(true);
      // Copy and export stay available: they change nothing.
      expect(button(/Copy CLI command/).disabled).toBe(false);
      expect(button(/Export voice stack/).disabled).toBe(false);
    });
  });

  describe('rename', () => {
    it('swaps the title for a focused input and reports every keystroke', () => {
      const onRename = vi.fn();
      render(<RenameHarness onRename={onRename} />);
      fireEvent.click(button('Rename rig'));
      const input = screen.getByLabelText('Rig name') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      expect(screen.queryByRole('button', { name: 'Rename rig' })).toBeNull();
      fireEvent.change(input, { target: { value: 'Cartesia vs Murf' } });
      expect(onRename).toHaveBeenLastCalledWith('Cartesia vs Murf');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.queryByLabelText('Rig name')).toBeNull();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Cartesia vs Murf');
    });

    it('Escape puts the old name back', () => {
      const onRename = vi.fn();
      render(<RenameHarness onRename={onRename} />);
      fireEvent.click(button('Rename rig'));
      const input = screen.getByLabelText('Rig name');
      fireEvent.change(input, { target: { value: 'oops' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(onRename).toHaveBeenLastCalledWith('Rig A');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Rig A');
    });

    it('an emptied name is restored on blur rather than left blank', () => {
      const onRename = vi.fn();
      render(<RenameHarness onRename={onRename} />);
      fireEvent.click(button('Rename rig'));
      const input = screen.getByLabelText('Rig name');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.blur(input);
      expect(onRename).toHaveBeenLastCalledWith('Rig A');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Rig A');
    });

    it('a non-empty name survives blur', () => {
      const onRename = vi.fn();
      render(<RenameHarness onRename={onRename} />);
      fireEvent.click(button('Rename rig'));
      const input = screen.getByLabelText('Rig name');
      fireEvent.change(input, { target: { value: 'Kept' } });
      fireEvent.blur(input);
      expect(onRename).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Kept');
    });

    it('locking mid-rename closes the input', () => {
      const { rerender } = render(<RenameHarness onRename={() => {}} />);
      fireEvent.click(button('Rename rig'));
      expect(screen.getByLabelText('Rig name')).toBeTruthy();
      rerender(<RenameHarness onRename={() => {}} locked />);
      expect(screen.queryByLabelText('Rig name')).toBeNull();
    });
  });

  describe('copy CLI command', () => {
    it('writes the rig command, says Copied, then resets', async () => {
      vi.useFakeTimers();
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      render(<BenchView {...baseProps()} />);
      await act(async () => {
        fireEvent.click(button(/Copy CLI command/));
      });
      expect(writeText).toHaveBeenCalledExactlyOnceWith(envCommandOf(baseRig, pickerProviders, 'Be brief.'));
      expect(button(/Copied/)).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(1800);
      });
      expect(button(/Copy CLI command/)).toBeTruthy();
    });

    it('opens the command for manual copying when the clipboard is missing', () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
      const { container } = render(<BenchView {...baseProps()} />);
      const details = container.querySelector('details.chain-cmd') as HTMLDetailsElement;
      expect(details.open).toBe(false);
      fireEvent.click(button(/Copy CLI command/));
      expect(button(/Copy failed, shown below/)).toBeTruthy();
      expect(details.open).toBe(true);
    });

    it('…and when the clipboard refuses', async () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(() => Promise.reject(new Error('no'))) } });
      const { container } = render(<BenchView {...baseProps()} />);
      await act(async () => {
        fireEvent.click(button(/Copy CLI command/));
      });
      expect(button(/Copy failed, shown below/)).toBeTruthy();
      expect((container.querySelector('details.chain-cmd') as HTMLDetailsElement).open).toBe(true);
    });

    it('does not set state after unmount when the reset timer fires', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { unmount } = render(<BenchView {...baseProps()} />);
      await act(async () => {
        fireEvent.click(button(/Copy CLI command/));
      });
      unmount();
      vi.advanceTimersByTime(5000);
      expect(errors).not.toHaveBeenCalled();
    });
  });

  describe('session bar', () => {
    it.each([
      ['idle', 'Not connected'],
      ['connecting', 'Connecting…'],
      ['ready', 'Live'],
      ['ending', 'Filing report…'],
      ['ended', 'Ended'],
      ['error', 'Error'],
      ['closed', 'Closed'],
    ] as const)('state %s reads "%s"', (state, words) => {
      const { container } = render(<BenchView {...baseProps({ session: makeSession({ state }) })} />);
      const badge = container.querySelector('.session-bar .badge')!;
      expect(badge.textContent).toBe(words);
      expect(badge.className).toBe(`badge ${state}`);
    });

    it('not connected: Connect is offered, mic and interrupt are not', () => {
      const p = baseProps();
      render(<BenchView {...p} />);
      expect(button(/Start mic/).disabled).toBe(true);
      expect(button(/Start mic/).getAttribute('aria-pressed')).toBe('false');
      expect(button(/Interrupt/).disabled).toBe(true);
      expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /End my turn/ })).toBeNull();
      fireEvent.click(button(/^Connect$/));
      expect(p.onConnect).toHaveBeenCalledTimes(1);
    });

    it('Connect waits for the catalog and refuses a second click while connecting', () => {
      const { rerender } = render(<BenchView {...baseProps({ providers: [] })} />);
      expect(button(/^Connect$/).disabled).toBe(true);
      rerender(<BenchView {...baseProps({ session: makeSession({ state: 'connecting' }) })} />);
      expect(button(/Connecting…/).disabled).toBe(true);
    });

    it('live: mic, meter, interrupt, disconnect and end all drive the session', () => {
      const session = makeSession({ state: 'ready', micOn: true, micLevel: 0.4 });
      render(<BenchView {...baseProps({ session, locked: true })} />);
      const mic = button(/Mic on/);
      expect(mic.getAttribute('aria-pressed')).toBe('true');
      expect(mic.getAttribute('title')).toBe('Stop the mic');
      expect(mic.className).toBe('btn hot');
      const meter = screen.getByRole('progressbar', { name: 'Mic level' });
      expect(meter.getAttribute('aria-valuenow')).toBe('56');
      expect(meter.getAttribute('aria-valuemin')).toBe('0');
      expect(meter.getAttribute('aria-valuemax')).toBe('100');
      expect(mic.contains(meter)).toBe(false);
      expect((meter.firstElementChild as HTMLElement).style.width).toBe('56%');

      fireEvent.click(mic);
      expect(session.stopMic).toHaveBeenCalledTimes(1);
      fireEvent.click(button(/Interrupt/));
      expect(session.interrupt).toHaveBeenCalledTimes(1);
      fireEvent.click(button(/Disconnect/));
      expect(session.disconnect).toHaveBeenCalledTimes(1);
      fireEvent.click(button(/End and file report/));
      expect(session.endConversation).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull();
    });

    it('starts the mic when connected and cold', () => {
      const session = makeSession({ state: 'ready' });
      render(<BenchView {...baseProps({ session })} />);
      fireEvent.click(button(/Start mic/));
      expect(session.startMic).toHaveBeenCalledTimes(1);
      expect(session.stopMic).not.toHaveBeenCalled();
    });

    it('caps the meter at 100', () => {
      render(<BenchView {...baseProps({ session: makeSession({ state: 'ready', micOn: true, micLevel: 3 }) })} />);
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    });

    it('keeps a hot mic stoppable after the socket drops', () => {
      const session = makeSession({ state: 'error', micOn: true });
      render(<BenchView {...baseProps({ session })} />);
      const mic = button(/Mic on/);
      expect(mic.disabled).toBe(false);
      fireEvent.click(mic);
      expect(session.stopMic).toHaveBeenCalledTimes(1);
    });

    it('holds a disabled placeholder in the primary slot while the report is filed', () => {
      render(<BenchView {...baseProps({ locked: true, session: makeSession({ state: 'ending' }) })} />);
      expect(button(/Ending…/).disabled).toBe(true);
      expect(screen.queryByRole('button', { name: /^Connect$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /End and file report/ })).toBeNull();
    });

    it('turn detection is a pressed-toggle group that reports the choice', () => {
      const p = baseProps();
      render(<BenchView {...p} />);
      const group = screen.getByRole('group', { name: 'Turn detection' });
      const [vad, ptt] = within(group).getAllByRole('button');
      expect(vad.getAttribute('aria-pressed')).toBe('true');
      expect(ptt.getAttribute('aria-pressed')).toBe('false');
      expect(ptt.getAttribute('title')).toBe('You end each turn yourself');
      fireEvent.click(ptt);
      expect(p.onTurnDetectionChange).toHaveBeenCalledExactlyOnceWith('manual' satisfies TurnDetection);
      fireEvent.click(vad);
      expect(p.onTurnDetectionChange).toHaveBeenLastCalledWith('server_vad');
    });

    it('push to talk adds End my turn, live only with a hot mic', () => {
      const session = makeSession({ state: 'ready', micOn: false });
      const { rerender } = render(<BenchView {...baseProps({ session, turnDetection: 'manual' })} />);
      expect(button(/End my turn/).disabled).toBe(true);
      const hot = makeSession({ state: 'ready', micOn: true });
      rerender(<BenchView {...baseProps({ session: hot, turnDetection: 'manual' })} />);
      fireEvent.click(button(/End my turn/));
      expect(hot.commitAudio).toHaveBeenCalledTimes(1);
    });

    it('locks turn detection for the life of the session', () => {
      render(<BenchView {...baseProps({ locked: true, turnDetection: 'manual', session: makeSession({ state: 'ready' }) })} />);
      expect(screen.queryByRole('group', { name: 'Turn detection' })).toBeNull();
      expect(within(sessionBar()).getByText('Turn detection: Push to talk')).toBeTruthy();
    });
  });

  describe('panels', () => {
    it('the composer sends through the session, only when connected', () => {
      const session = makeSession({ state: 'ready' });
      render(<BenchView {...baseProps({ session })} />);
      fireEvent.change(screen.getByLabelText('Type a turn'), { target: { value: 'hello' } });
      fireEvent.click(button(/^Send$/));
      expect(session.sendText).toHaveBeenCalledExactlyOnceWith('hello');
    });

    it('wires turns, usage, utterances and speaking into the panels', () => {
      const session = makeSession({
        state: 'ready', turns: [pipelineTurn], usage: SYNTHETIC.turns, assistantSpeaking: true,
        utterances: [{ role: 'user', text: 'what is up', final: true }],
      });
      const { container } = render(<BenchView {...baseProps({ session })} />);
      expect(screen.getByText('1 turn')).toBeTruthy();
      expect(screen.getByText('what is up')).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain('Assistant speaking');
      expect(container.querySelectorAll('.wf-row')).toHaveLength(1);
      expect(container.querySelector('.hero-v')?.textContent).toBe('548');
      expect(screen.getByRole('heading', { name: /^Cost/ })).toBeTruthy();
    });

    it('the system prompt widget edits through the parent', () => {
      const p = baseProps();
      render(<BenchView {...p} />);
      fireEvent.change(screen.getByLabelText('System prompt text'), { target: { value: 'New prompt' } });
      expect(p.onSystemPromptChange).toHaveBeenCalledExactlyOnceWith('New prompt');
    });

    it('notes how many turns ran in this tab once there are some', () => {
      const { rerender } = render(<BenchView {...baseProps({ score: { turns: 0 } })} />);
      expect(screen.queryByText(/turns run in this tab/)).toBeNull();
      rerender(<BenchView {...baseProps({ score: { turns: 4, ttfaMedianMs: 600 } })} />);
      expect(screen.getByText(/4 turns run in this tab/)).toBeTruthy();
    });

    it('the rail cards open the editor and lock with the rig', () => {
      const p = baseProps({ locked: true, session: makeSession({ state: 'ready' }) as VoiceSessionHandle });
      const { container } = render(<BenchView {...p} />);
      const cards = [...container.querySelectorAll('.chain-card')] as HTMLButtonElement[];
      expect(cards.every((c) => c.disabled)).toBe(true);
    });
  });
});
