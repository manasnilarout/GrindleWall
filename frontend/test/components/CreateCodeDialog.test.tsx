// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CreateCodeDialog } from '../../src/components/CreateCodeDialog';
import { decodeVoiceStack } from '../../src/lib/voice-stack/spec';
import { AUTH_STORAGE_KEY } from '../../src/lib/auth';
import type { Rig } from '../../src/lib/rigs';
import {
  NOW, STACK_CODE, hiOr, idProviders, novaProviders, novaRig, routedFetch, stackPrompt, stackProviders, stackRig, stackSessions,
} from './fixtures';

type Props = Parameters<typeof CreateCodeDialog>[0];
const props = (over: Partial<Props> = {}): Props => ({
  rig: stackRig,
  providers: stackProviders,
  systemPrompt: stackPrompt,
  turnDetection: 'server_vad',
  onClose: vi.fn(),
  ...over,
});

const codeBox = () => screen.queryByLabelText('Voice stack code') as HTMLTextAreaElement | null;
const decoded = () => {
  const box = codeBox();
  if (!box) throw new Error('no code rendered');
  expect(box.value).toMatch(STACK_CODE);
  const result = decodeVoiceStack(box.value);
  if (!result.ok) throw new Error(result.error.message);
  return result.spec;
};
const rowCodes = (c: HTMLElement) => [...c.querySelectorAll('.cc-row .cc-lang code')].map((e) => e.textContent);
const checklist = (c: HTMLElement) => [...c.querySelectorAll('.checklist li')].map((li) => li.textContent);

describe('CreateCodeDialog', () => {
  afterEach(() => {
    localStorage.clear();
    delete (document as Partial<Document>).execCommand;
  });

  describe('the drawer', () => {
    it('is a labelled modal that takes focus and closes on Close and Escape', () => {
      const p = props({ sessions: [] });
      const { container } = render(<CreateCodeDialog {...p} />);
      const dialog = screen.getByRole('dialog', { name: 'Create code for Hindi collections' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(document.activeElement).toBe(dialog);
      expect(within(dialog).getByRole('heading', { level: 1, name: 'Create code' })).toBeTruthy();
      expect(container.querySelector('.sheet-badge')?.textContent).toBe('A');
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(p.onClose).toHaveBeenCalledTimes(2);
    });

    it('closes from the scrim only when the gesture starts there', () => {
      const p = props({ sessions: [] });
      const { container } = render(<CreateCodeDialog {...p} />);
      const scrim = container.firstElementChild as HTMLElement;
      fireEvent.mouseDown(screen.getByRole('dialog'));
      fireEvent.click(scrim);
      expect(p.onClose).not.toHaveBeenCalled();
      fireEvent.mouseDown(scrim);
      fireEvent.click(scrim);
      expect(p.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('producing the code', () => {
    it('renders a code that decodes to exactly what the rig ran', () => {
      const { container } = render(<CreateCodeDialog {...props({ sessions: stackSessions, languages: hiOr })} />);
      const spec = decoded();
      expect(spec.stt).toEqual({ provider: 'sarvam', model: 'saaras:v3-realtime', options: { streamType: 'fast' } });
      expect(spec.llm).toEqual({ provider: 'google', model: 'gemini-3.1-flash-lite', options: { reasoning: 'minimal' } });
      expect(spec.tts).toEqual({ provider: 'sarvam', model: 'bulbul:v3', options: {} });
      expect(spec.languages).toEqual([
        { code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' },
        { code: 'or', stt: 'or-IN', tts: 'od-IN', voice: 'shubh' },
      ]);
      expect(spec.turn).toEqual({ detection: 'server_vad' });
      expect(spec.meta.name).toBe('Hindi collections');
      expect(spec.meta.provenance?.sessions).toEqual(['rec-hi-1', 'rec-hi-open-tab', 'rec-or-1']);
      // The decoded spec is shown, and the copy row names the checksum.
      expect(JSON.parse(container.querySelector('pre.jsonbox')!.textContent!)).toEqual(spec);
      const copyRow = container.querySelector('.cc-copy')!.textContent!;
      expect(copyRow).toContain(`${codeBox()!.value.length.toLocaleString()} characters · checksum`);
      expect(copyRow).toContain(codeBox()!.value.slice(-8));
      expect(copyRow).toContain('decodes');
      expect(checklist(container).find((t) => t?.startsWith('Passed: '))).toMatch(/^Passed: Ready: 2 languages, default hi/);
    });

    it('shows the legs as core will read them', () => {
      const { container } = render(<CreateCodeDialog {...props({ sessions: [] })} />);
      const legs = [...container.querySelectorAll('.cc-leg')].map((d) => d.textContent);
      expect(legs).toEqual([
        'STTsarvam · saaras:v3-realtime · streamType=fast',
        'LLMgoogle · gemini-3.1-flash-lite · reasoning=minimal',
        'TTSsarvam · bulbul:v3',
      ]);
    });

    it('a leg core has no id for is shown raw and blocks', () => {
      const rig: Rig = { ...stackRig, llmProviderId: 'groq-llm', llmModelId: 'llama-3.3-70b' };
      const { container } = render(<CreateCodeDialog {...props({ rig, sessions: [] })} />);
      expect(container.querySelector('.cc-leg code.muted')?.textContent).toBe('groq-llm:llama-3.3-70b');
      expect(codeBox()).toBeNull();
      expect(screen.getByText('Clear the blockers above to produce a code.')).toBeTruthy();
      expect(checklist(container).some((t) => t?.startsWith('Blocker: ') && t.includes('has no MagickVoice LLM provider id'))).toBe(true);
    });

    it('the name and description travel in the code', () => {
      render(<CreateCodeDialog {...props({ sessions: [] })} />);
      fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: '  Collections v2  ' } });
      fireEvent.change(screen.getByLabelText(/^Description/), { target: { value: 'for the north desk' } });
      const spec = decoded();
      expect(spec.meta.name).toBe('Collections v2');
      expect(spec.meta.description).toBe('for the north desk');
    });

    it('waits for the sessions listing before producing a code, then cites it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const fetch = routedFetch(async (url) => {
        if (url !== '/api/sessions') return undefined;
        await gate;
        return { body: { sessions: stackSessions } };
      });
      vi.stubGlobal('fetch', fetch);
      const { container } = render(<CreateCodeDialog {...props({ languages: hiOr })} />);
      expect(screen.getByText('Reading recorded sessions…')).toBeTruthy();
      expect(screen.getByText('Waiting for recorded sessions before producing the code…')).toBeTruthy();
      expect(codeBox()).toBeNull();
      await act(async () => release());
      await waitFor(() => expect(codeBox()).not.toBeNull());
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(decoded().meta.provenance?.sessionCount).toBe(3);
      const stats = container.querySelector('.cc-stats')!.textContent!;
      expect(stats).toContain('3sessions');
      expect(stats).toContain('1000 ms');
      expect(stats).toContain('median session p95 1500 ms');
      expect(stats).toContain('$0.03 · ₹2.7');
      expect(stats).toContain('(floor — a leg was unpriced)');
      expect(stats).toContain('hi, orlanguages spoken');
      expect(container.textContent).toContain('Travels in the code as provenance; core never reads it.');
    });

    it('sends the session token when signed in', async () => {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'tok', username: 'u', expiresAt: NOW * 10 }));
      const fetch = routedFetch((url) => (url === '/api/sessions' ? { body: { sessions: [] } } : undefined));
      vi.stubGlobal('fetch', fetch);
      render(<CreateCodeDialog {...props()} />);
      await waitFor(() => expect(codeBox()).not.toBeNull());
      const headers = fetch.mock.calls[0][1]?.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer tok');
    });

    it('a failed listing costs the provenance, not the code', async () => {
      vi.stubGlobal('fetch', routedFetch(() => ({ status: 500 })));
      render(<CreateCodeDialog {...props()} />);
      await screen.findByText('Could not read recorded sessions (HTTP 500). The code is exported without measurements.');
      expect(decoded().meta.provenance?.sessions).toBeUndefined();
    });

    it('a listing without a sessions array counts as none', async () => {
      vi.stubGlobal('fetch', routedFetch(() => ({ body: { nope: true } })));
      render(<CreateCodeDialog {...props()} />);
      await screen.findByText(/No recorded session matches this stack yet/);
      expect(codeBox()).not.toBeNull();
    });

    it('does not fetch when sessions are injected', () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      render(<CreateCodeDialog {...props({ sessions: [] })} />);
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByText(/No recorded session matches this stack yet/)).toBeTruthy();
    });
  });

  describe('refusals', () => {
    it('refuses a push-to-talk bench and says the level in words', () => {
      const { container } = render(<CreateCodeDialog {...props({ turnDetection: 'manual', sessions: stackSessions, languages: hiOr })} />);
      expect(codeBox()).toBeNull();
      const blocker = container.querySelector('.checklist li.check.block')!;
      expect(blocker.querySelector('.sr-only')?.textContent).toBe('Blocker: ');
      expect(blocker.textContent).toContain('Push-to-talk (manual turn detection) cannot be exported');
      expect(blocker.querySelector('svg.check-mark')).toBeTruthy();
      expect(container.textContent).not.toContain('Ready:');
    });

    it('refuses a realtime rig and hides the pipeline-only sections', () => {
      const rig: Rig = { ...stackRig, mode: 'realtime', realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime' };
      const { container } = render(<CreateCodeDialog {...props({ rig, sessions: stackSessions })} />);
      expect(codeBox()).toBeNull();
      expect(container.querySelector('.cc-legs')).toBeNull();
      expect(screen.queryByRole('heading', { name: /Languages/ })).toBeNull();
      expect(screen.queryByRole('heading', { name: /Measured on this bench/ })).toBeNull();
      expect(checklist(container).join(' ')).toContain('Realtime stacks are not supported by core yet');
    });

    it('refuses a Nova Sonic rig the same way', () => {
      render(<CreateCodeDialog {...props({ rig: novaRig, providers: [...stackProviders, ...novaProviders], sessions: stackSessions })} />);
      expect(codeBox()).toBeNull();
      expect(screen.getByText(/Realtime stacks are not supported by core yet/)).toBeTruthy();
    });

    it('sorts the checklist blockers first, then warnings, then passes', () => {
      const { container } = render(<CreateCodeDialog {...props({ turnDetection: 'manual', sessions: [], languages: hiOr })} />);
      const levels = [...container.querySelectorAll('.checklist li')].map((li) => li.className.replace('check ', ''));
      const order = { block: 0, warn: 1, ok: 2 } as Record<string, number>;
      expect(levels).toEqual([...levels].sort((a, b) => order[a] - order[b]));
      expect(levels[0]).toBe('block');
    });
  });

  describe('language rows', () => {
    it('starts with the one language the rig speaks, pinned off auto-detect', () => {
      const { container } = render(<CreateCodeDialog {...props({ sessions: [] })} />);
      expect(rowCodes(container)).toEqual(['hi']);
      expect(container.querySelector('.cc-row .pill.vendor')?.textContent).toBe('default');
      expect(decoded().languages).toEqual([{ code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'pooja' }]);
    });

    it('adds a language both legs list, and then has none left to add', () => {
      const { container } = render(<CreateCodeDialog {...props({ sessions: [] })} />);
      const add = screen.getByRole('button', { name: /Add language/ }) as HTMLButtonElement;
      const picker = screen.getByLabelText(/Add a language both legs list \(1 more\)/) as HTMLSelectElement;
      expect([...picker.options].map((o) => o.value)).toEqual(['or']);
      expect(picker.options[0].textContent).toBe('Odia — STT or-IN · TTS od-IN');
      fireEvent.click(add);
      expect(rowCodes(container)).toEqual(['hi', 'or']);
      expect(decoded().languages.map((l) => [l.code, l.stt, l.tts])).toEqual([['hi', 'hi-IN', 'hi-IN'], ['or', 'or-IN', 'od-IN']]);
      expect(add.disabled).toBe(true);
      expect(screen.getByLabelText(/\(0 more\)/)).toBeTruthy();
    });

    it('Make default moves a row to the front; Remove drops it', () => {
      const { container } = render(<CreateCodeDialog {...props({ sessions: [], languages: hiOr })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
      expect(rowCodes(container)).toEqual(['or', 'hi']);
      expect(decoded().languages[0].code).toBe('or');
      fireEvent.click(screen.getByRole('button', { name: 'Remove or' }));
      expect(rowCodes(container)).toEqual(['hi']);
      expect(screen.queryByRole('button', { name: 'Make default' })).toBeNull();
    });

    it('removing every row blocks the code and says what to do', () => {
      const { container } = render(<CreateCodeDialog {...props({ sessions: [] })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Remove hi' }));
      expect(screen.getByText('No language yet — add one both legs support.')).toBeTruthy();
      expect(codeBox()).toBeNull();
      expect(checklist(container).join(' ')).toContain('Pick at least one language');
    });

    it('changing a row\'s codes and voice flows into the code', () => {
      render(<CreateCodeDialog {...props({ sessions: [] })} />);
      expect([...(screen.getByLabelText('STT code') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['hi-IN']);
      fireEvent.change(screen.getByLabelText('Voice'), { target: { value: 'shubh' } });
      expect(decoded().languages[0].voice).toBe('shubh');
      fireEvent.change(screen.getByLabelText('TTS code'), { target: { value: 'hi-IN' } });
      // The voice is re-resolved against the language and kept, as Sarvam's list is flat.
      expect(decoded().languages[0]).toEqual({ code: 'hi', stt: 'hi-IN', tts: 'hi-IN', voice: 'shubh' });
    });

    it('a row voice the catalogue does not list is still shown, so it is not silently swapped', () => {
      render(<CreateCodeDialog {...props({ sessions: [], languages: [{ ...hiOr[0], voice: 'ghost' }] })} />);
      const voice = screen.getByLabelText('Voice') as HTMLSelectElement;
      expect(voice.value).toBe('ghost');
      expect([...voice.options].map((o) => o.value)).toEqual(['ghost', 'shubh', 'pooja']);
      expect(screen.getByText(/"ghost" is not a bulbul:v3 voice/)).toBeTruthy();
    });

    it('a vendor that takes ids gets a custom voice field per row, overriding the picker', () => {
      render(<CreateCodeDialog {...props({ providers: idProviders, sessions: [] })} />);
      const custom = screen.getByLabelText('Custom voice id') as HTMLInputElement;
      fireEvent.change(custom, { target: { value: ' cloned-7 ' } });
      expect((screen.getByLabelText(/Voice — overridden/) as HTMLSelectElement).disabled).toBe(true);
      expect(decoded().languages[0].voice).toBe('cloned-7');
    });

    it('a rig with a typed voice id keeps it on every row it is handed', () => {
      const rig = { ...stackRig, customVoiceId: 'cloned-7' };
      render(<CreateCodeDialog {...props({ rig, providers: idProviders, sessions: [] })} />);
      fireEvent.click(screen.getByRole('button', { name: /Add language/ }));
      expect(decoded().languages.map((l) => `${l.code}:${l.voice}`)).toEqual(['hi:cloned-7', 'or:cloned-7']);
      expect(screen.getAllByLabelText(/Voice — overridden/)).toHaveLength(2);
    });

    it('a TTS leg that lists no voices says so', () => {
      const silent = stackProviders.map((p) => (p.id === 'sarvam-tts' ? { ...p, voices: [] } : p));
      render(<CreateCodeDialog {...props({ providers: silent, sessions: [] })} />);
      expect(screen.getByText('None listed')).toBeTruthy();
      const typed = silent.map((p) => (p.id === 'sarvam-tts' ? { ...p, acceptsVoiceId: true } : p));
      render(<CreateCodeDialog {...props({ providers: typed, sessions: [] })} />);
      expect(screen.getByText('None listed — type an id')).toBeTruthy();
    });
  });

  describe('copy', () => {
    it('writes the code to the clipboard and says Copied', async () => {
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      render(<CreateCodeDialog {...props({ sessions: [] })} />);
      const code = codeBox()!.value;
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Copy code/ }));
      });
      expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
      expect(screen.getByRole('button', { name: /^Copied$/ })).toBeTruthy();
    });

    it('without the clipboard API it selects the box and uses execCommand', () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
      const execCommand = vi.fn(() => true);
      (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;
      render(<CreateCodeDialog {...props({ sessions: [] })} />);
      const box = codeBox()!;
      fireEvent.click(screen.getByRole('button', { name: /Copy code/ }));
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(document.activeElement).toBe(box);
      expect(box.selectionStart).toBe(0);
      expect(box.selectionEnd).toBe(box.value.length);
      expect(screen.getByRole('button', { name: /^Copied$/ })).toBeTruthy();
    });

    it('says Selected, not Copied, when neither copy path works', async () => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(() => Promise.reject(new Error('no gesture'))) } });
      (document as unknown as { execCommand: () => boolean }).execCommand = () => {
        throw new Error('unsupported');
      };
      render(<CreateCodeDialog {...props({ sessions: [] })} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Copy code/ }));
      });
      expect(screen.getByRole('button', { name: /Selected — press Ctrl\/⌘\+C/ })).toBeTruthy();
    });

    it('the code box is read-only and selects itself on focus', () => {
      render(<CreateCodeDialog {...props({ sessions: [] })} />);
      const box = codeBox()!;
      expect(box.readOnly).toBe(true);
      fireEvent.focus(box);
      expect(box.selectionEnd).toBe(box.value.length);
    });
  });
});
