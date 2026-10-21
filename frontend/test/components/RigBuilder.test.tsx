// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { RigBuilder } from '../../src/components/RigBuilder';
import { LEG_BANDS } from '../../src/lib/legs';
import { languagesFor, voicesFor, type ModelEntry, type ProviderEntry } from '../../src/lib/catalog';
import { envCommandOf, type Rig } from '../../src/lib/rigs';
import {
  allProviders, baseRig, cartesiaRig, murfRig, novaProviders, novaRig, openaiRealtime, pickerProviders, stackProviders,
} from './fixtures';

/** Holds the rig the way App does, so a sequence of edits compounds. */
function Harness({
  initial,
  providers,
  onChange,
  onClose = () => {},
  disabled = false,
  systemPrompt,
}: {
  initial: Rig;
  providers: ProviderEntry[];
  onChange?: (r: Rig) => void;
  onClose?: () => void;
  disabled?: boolean;
  systemPrompt?: string;
}) {
  const [rig, setRig] = useState(initial);
  return (
    <RigBuilder
      rig={rig}
      providers={providers}
      disabled={disabled}
      systemPrompt={systemPrompt}
      onClose={onClose}
      onChange={(next) => {
        onChange?.(next);
        setRig(next);
      }}
    />
  );
}

const sttLike = stackProviders.find((p) => p.id === 'sarvam-stt')!;
const withStt: ProviderEntry[] = [...allProviders, sttLike];

const chip = (group: string, name: string) =>
  within(screen.getByRole('radiogroup', { name: `${group} provider` })).getByRole('radio', { name: new RegExp(name) }) as HTMLButtonElement;
const section = (title: string) => screen.getByRole('region', { name: new RegExp(title) });
const selectIn = (title: string, label: string | RegExp) => within(section(title)).getByLabelText(label) as HTMLSelectElement;
const voiceRows = (c: HTMLElement) => [...c.querySelectorAll('.voice-row')] as HTMLButtonElement[];
const lastRig = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[spy.mock.calls.length - 1][0] as Rig;

describe('RigBuilder', () => {
  afterEach(() => vi.useRealTimers());

  describe('the drawer', () => {
    it('is a labelled modal dialog on the panel (not the scrim) and takes focus', () => {
      const { container } = render(<Harness initial={baseRig} providers={pickerProviders} />);
      const dialog = screen.getByRole('dialog', { name: 'Edit Rig A' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.className).toBe('drawer');
      expect((container.firstElementChild as HTMLElement).className).toBe('drawer-scrim');
      expect(document.activeElement).toBe(dialog);
      expect(within(dialog).getByRole('heading', { level: 1, name: 'Rig A' })).toBeTruthy();
      expect(container.querySelector('.sheet-badge')?.textContent).toBe('A');
    });

    it('closes on Done, on the close icon and on Escape', () => {
      const onClose = vi.fn();
      render(<Harness initial={baseRig} providers={pickerProviders} onClose={onClose} />);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Enter' });
      expect(onClose).toHaveBeenCalledTimes(3);
    });

    it('closes on a click that starts and ends on the scrim, never on a drag out of the panel', () => {
      const onClose = vi.fn();
      const { container } = render(<Harness initial={baseRig} providers={pickerProviders} onClose={onClose} />);
      const scrim = container.firstElementChild as HTMLElement;
      const panel = screen.getByRole('dialog');
      // A drag that began inside and released over the scrim.
      fireEvent.mouseDown(panel);
      fireEvent.click(scrim);
      expect(onClose).not.toHaveBeenCalled();
      // A click inside the panel.
      fireEvent.mouseDown(panel);
      fireEvent.click(panel);
      expect(onClose).not.toHaveBeenCalled();
      // A real dismissal.
      fireEvent.mouseDown(scrim);
      fireEvent.click(scrim);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stops listening for Escape once unmounted', () => {
      const onClose = vi.fn();
      const { unmount } = render(<Harness initial={baseRig} providers={pickerProviders} onClose={onClose} />);
      unmount();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('architecture', () => {
    it('is a radio pair with pipeline checked, and the pipeline legs in their LEG_BANDS colours', () => {
      const { container } = render(<Harness initial={baseRig} providers={pickerProviders} />);
      const radios = within(screen.getByRole('group', { name: 'Architecture' })).getAllByRole('radio') as HTMLInputElement[];
      expect(radios.map((r) => [r.value, r.checked])).toEqual([['pipeline', true], ['realtime', false]]);
      expect(radios[0].name).toBe(radios[1].name);
      const steps = [...container.querySelectorAll('.leg-step')] as HTMLElement[];
      expect(steps.map((s) => s.textContent)).toEqual(['1', '2', '3']);
      const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      expect(steps.map((s) => s.style.background)).toEqual(LEG_BANDS.map((b) => rgb(b.color)));
      for (const t of ['Speech to text', 'Language model', 'Text to speech']) expect(section(t)).toBeTruthy();
    });

    it('switching to realtime re-resolves the shared voice to the realtime provider, and clears a typed id', () => {
      const onChange = vi.fn();
      const rig: Rig = { ...baseRig, realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime-2.1', customVoiceId: 'typed' };
      render(<Harness initial={rig} providers={allProviders} onChange={onChange} />);
      fireEvent.click(screen.getByRole('radio', { name: /Realtime/ }));
      const next = lastRig(onChange);
      expect(next.mode).toBe('realtime');
      expect(next.voice).toBe('marin');
      expect(next.customVoiceId).toBe('');
      // The pipeline legs are gone; one speech-to-speech section remains.
      expect(screen.queryByRole('region', { name: /Speech to text/ })).toBeNull();
      expect(section('Speech to speech')).toBeTruthy();
      // …and back, to a voice the TTS leg offers.
      fireEvent.click(screen.getByRole('radio', { name: /Pipeline/ }));
      expect(lastRig(onChange)).toMatchObject({ mode: 'pipeline', voice: 'priya' });
    });
  });

  describe('provider chips', () => {
    it('are radios carrying readiness: checked, missing a key, not wired', () => {
      const providers: ProviderEntry[] = [
        ...pickerProviders,
        { id: 'keyless-tts', name: 'Keyless Voice', kind: 'tts', implemented: true, registered: true, ready: false,
          envKeys: ['K1', 'K2'], missingEnv: ['K1', 'K2'], models: [{ id: 'k-1', name: 'k-1' }] },
        { id: 'deepgram-tts', name: 'Deepgram Aura', kind: 'tts', implemented: false, registered: false, ready: false,
          envKeys: ['DEEPGRAM_API_KEY'], missingEnv: ['DEEPGRAM_API_KEY'], models: [{ id: 'aura-2', name: 'aura-2' }] },
      ];
      render(<Harness initial={baseRig} providers={providers} />);
      const on = chip('TTS', 'Sarvam Bulbul');
      expect(on.getAttribute('aria-checked')).toBe('true');
      expect(on.className).toBe('p-chip on ');
      const keyless = chip('TTS', 'Keyless Voice');
      expect(keyless.disabled).toBe(false);
      expect(keyless.className).toBe('p-chip  miss');
      expect(keyless.textContent).toContain('Needs K1 +1');
      expect(keyless.getAttribute('title')).toBe('Needs K1, K2 in backend/.env');
      const unwired = chip('TTS', 'Deepgram Aura');
      expect(unwired.disabled).toBe(true);
      expect(unwired.textContent).toContain('· not wired');
      expect(unwired.getAttribute('title')).toBe('Not wired up in factory.ts yet');
    });

    it.each([
      ['Murf Falcon', 'murf-tts'],
      ['Cartesia Sonic', 'cartesia-tts'],
      ['Sarvam Bulbul', 'sarvam-tts'],
    ])('picking %s resets model, language and voice to a valid selection', (name, id) => {
      const onChange = vi.fn();
      const start: Rig = { ...murfRig, ttsProviderId: id === 'murf-tts' ? 'sarvam-tts' : 'murf-tts', ttsModelId: 'x', customVoiceId: 'typed' };
      render(<Harness initial={start} providers={pickerProviders} onChange={onChange} />);
      fireEvent.click(chip('TTS', name));
      const next = lastRig(onChange);
      const entry = pickerProviders.find((p) => p.id === id)!;
      const model = entry.models[0].id;
      const lang = languagesFor(pickerProviders, id, model)[0]?.id ?? '';
      expect(next).toMatchObject({
        ttsProviderId: id,
        ttsModelId: model,
        ttsLanguage: lang,
        voice: voicesFor(pickerProviders, id, model, lang)[0]?.id ?? '',
        customVoiceId: '',
      });
      // Untouched legs stay put.
      expect(next.sttProviderId).toBe(start.sttProviderId);
      expect(next.llmModelId).toBe(start.llmModelId);
    });

    it('picking an STT provider resets its model and language and leaves the voice alone', () => {
      const onChange = vi.fn();
      render(<Harness initial={baseRig} providers={withStt} onChange={onChange} />);
      fireEvent.click(chip('STT', 'Sarvam Saaras'));
      expect(lastRig(onChange)).toMatchObject({
        sttProviderId: 'sarvam-stt', sttModelId: 'saaras:v3-realtime@fast', sttLanguage: 'auto', voice: 'priya',
      });
      // The leg now offers its languages.
      expect([...selectIn('Speech to text', 'Language').options].map((o) => o.value)).toEqual(['auto', 'hi-IN', 'or-IN', 'ta-IN']);
    });

    it('picking a realtime provider resets model, language and voice under it', () => {
      const onChange = vi.fn();
      render(<Harness initial={{ ...novaRig, voice: 'ambre', language: 'fr-FR' }} providers={allProviders} onChange={onChange} />);
      fireEvent.click(chip('Realtime', 'OpenAI Realtime'));
      expect(lastRig(onChange)).toMatchObject({
        realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime-2.1', language: '', voice: 'marin', customVoiceId: '',
      });
      // OpenAI publishes no language list, so the select disappears.
      expect(within(section('Speech to speech')).queryByLabelText('Language')).toBeNull();
      fireEvent.click(chip('Realtime', 'AWS Nova Sonic'));
      expect(lastRig(onChange)).toMatchObject({ language: 'en-IN', voice: 'kiara' });
    });

    it('a chip with no models empties the model rather than inventing one', () => {
      const onChange = vi.fn();
      const empty: ProviderEntry = { ...openaiRealtime, id: 'empty-rt', name: 'Empty RT', models: [], voices: [] };
      render(<Harness initial={novaRig} providers={[...novaProviders, empty]} onChange={onChange} />);
      fireEvent.click(chip('Realtime', 'Empty RT'));
      expect(lastRig(onChange)).toMatchObject({ realtimeProviderId: 'empty-rt', realtimeModelId: '', voice: '', language: '' });
    });
  });

  describe('model and language selects', () => {
    it('a TTS model change re-resolves the voice to the new model catalogue', () => {
      const onChange = vi.fn();
      const { container } = render(<Harness initial={murfRig} providers={pickerProviders} onChange={onChange} />);
      const model = selectIn('Text to speech', 'Model');
      expect(model.className).toBe('mono');
      expect([...model.options].map((o) => o.value)).toEqual(['falcon-2', 'gen2']);
      fireEvent.change(model, { target: { value: 'gen2' } });
      expect(lastRig(onChange)).toMatchObject({ ttsModelId: 'gen2', voice: 'en-US-imani', ttsLanguage: 'en-US', customVoiceId: '' });
      expect(voiceRows(container).map((r) => r.querySelector('.id')?.textContent)).toEqual(['en-US-imani']);
    });

    it('languages follow the model: sonic-2 drops Hindi and lands on a language it takes', () => {
      const onChange = vi.fn();
      render(<Harness initial={{ ...cartesiaRig, ttsLanguage: 'hi', voice: 'amrit-id' }} providers={pickerProviders} onChange={onChange} />);
      const language = () => selectIn('Text to speech', /Language/);
      expect([...language().options].map((o) => o.value)).toEqual(['en', 'hi']);
      expect(within(section('Text to speech')).getByText(/2 on this model/)).toBeTruthy();
      fireEvent.change(selectIn('Text to speech', 'Model'), { target: { value: 'sonic-2' } });
      expect(lastRig(onChange)).toMatchObject({ ttsModelId: 'sonic-2', ttsLanguage: 'en', voice: 'skylar-id' });
      expect([...language().options].map((o) => o.value)).toEqual(['en']);
    });

    it('voices follow the language; an id valid in both survives', () => {
      const onChange = vi.fn();
      const { container } = render(<Harness initial={cartesiaRig} providers={pickerProviders} onChange={onChange} />);
      expect(voiceRows(container).map((r) => r.querySelector('.voice-name')?.textContent)).toEqual(['Skylar (F)']);
      fireEvent.change(selectIn('Text to speech', /Language/), { target: { value: 'hi' } });
      expect(lastRig(onChange)).toMatchObject({ ttsLanguage: 'hi', voice: 'aadhya-id' });
      expect(voiceRows(container).map((r) => r.querySelector('.voice-name')?.textContent)).toEqual(['Aadhya (F)', 'Amrit (M)']);
    });

    it('a realtime language change narrows the voices, keeping the polyglot voice', () => {
      const onChange = vi.fn();
      const { container } = render(<Harness initial={{ ...novaRig, voice: 'tiffany' }} providers={novaProviders} onChange={onChange} />);
      expect(voiceRows(container).map((r) => r.querySelector('.id')?.textContent)).toEqual(['kiara', 'tiffany']);
      fireEvent.change(selectIn('Speech to speech', 'Language'), { target: { value: 'fr-FR' } });
      expect(lastRig(onChange)).toMatchObject({ language: 'fr-FR', voice: 'tiffany' });
      expect(voiceRows(container).map((r) => r.querySelector('.id')?.textContent)).toEqual(['ambre', 'tiffany']);
    });

    it('a realtime model change goes through the voiced-model rule', () => {
      const onChange = vi.fn();
      const twoModels: ProviderEntry = { ...openaiRealtime, models: [...openaiRealtime.models, { id: 'gpt-realtime-mini', name: 'mini' }] };
      const rig: Rig = { ...novaRig, realtimeProviderId: 'openai-realtime', realtimeModelId: 'gpt-realtime-2.1', voice: 'cedar', language: '' };
      render(<Harness initial={rig} providers={[twoModels]} onChange={onChange} />);
      fireEvent.change(selectIn('Speech to speech', 'Model'), { target: { value: 'gpt-realtime-mini' } });
      expect(lastRig(onChange)).toMatchObject({ realtimeModelId: 'gpt-realtime-mini', voice: 'cedar', customVoiceId: '' });
    });

    it('STT model and language, and the LLM model, are each written to their own field', () => {
      const onChange = vi.fn();
      const twoStt: ProviderEntry = {
        ...sttLike,
        models: [
          { id: 'a', name: 'a', languages: [{ id: 'hi-IN', name: 'Hindi' }, { id: 'ta-IN', name: 'Tamil' }] },
          { id: 'b', name: 'b', languages: [{ id: 'ta-IN', name: 'Tamil' }] },
        ],
      };
      const twoLlm: ProviderEntry = { ...pickerProviders[1], models: [{ id: 'm1', name: 'm1', note: 'fast' }, { id: 'm2', name: 'm2' }] };
      const rig: Rig = { ...baseRig, sttProviderId: 'sarvam-stt', sttModelId: 'a', sttLanguage: 'hi-IN', llmModelId: 'm1' };
      render(<Harness initial={rig} providers={[twoStt, twoLlm, pickerProviders[2]]} onChange={onChange} />);

      fireEvent.change(selectIn('Speech to text', 'Language'), { target: { value: 'ta-IN' } });
      expect(lastRig(onChange).sttLanguage).toBe('ta-IN');
      fireEvent.change(selectIn('Speech to text', 'Language'), { target: { value: 'hi-IN' } });
      fireEvent.change(selectIn('Speech to text', 'Model'), { target: { value: 'b' } });
      // Hindi is not offered by model b, so it falls to the first it is.
      expect(lastRig(onChange)).toMatchObject({ sttModelId: 'b', sttLanguage: 'ta-IN' });

      // The hint sits inside the label, so the label's text is longer than "Model".
      const llm = selectIn('Language model', /^Model/);
      expect([...llm.options].map((o) => o.textContent)).toEqual(['m1 — fast', 'm2']);
      expect(within(section('Language model')).getByText(/only measured combinations are listed/)).toBeTruthy();
      fireEvent.change(llm, { target: { value: 'm2' } });
      expect(lastRig(onChange)).toMatchObject({ llmModelId: 'm2', sttModelId: 'b' });
    });

    it('hides the language select for a leg with no languages', () => {
      render(<Harness initial={baseRig} providers={pickerProviders} />);
      expect(within(section('Speech to text')).queryByLabelText('Language')).toBeNull();
    });
  });

  describe('voice picker', () => {
    it('lists voices as pressed toggles and picks by id', () => {
      const onChange = vi.fn();
      const { container } = render(<Harness initial={{ ...cartesiaRig, ttsLanguage: 'hi', voice: 'aadhya-id' }} providers={pickerProviders} onChange={onChange} />);
      const rows = voiceRows(container);
      expect(rows.map((r) => r.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
      expect(screen.getByText(/· 2 available/)).toBeTruthy();
      fireEvent.click(rows[1]);
      expect(lastRig(onChange)).toMatchObject({ voice: 'amrit-id' });
      expect(voiceRows(container).map((r) => r.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    });

    it('searches by name or id and says when nothing matches', () => {
      const { container } = render(<Harness initial={{ ...cartesiaRig, ttsLanguage: 'hi', voice: 'aadhya-id' }} providers={pickerProviders} />);
      const search = screen.getByPlaceholderText('search by name or id…');
      fireEvent.change(search, { target: { value: 'AMRIT' } });
      expect(voiceRows(container).map((r) => r.querySelector('.id')?.textContent)).toEqual(['amrit-id']);
      fireEvent.change(search, { target: { value: 'aadhya-id' } });
      expect(voiceRows(container)).toHaveLength(1);
      fireEvent.change(search, { target: { value: 'zzz' } });
      expect(voiceRows(container)).toHaveLength(0);
      expect(screen.getByText('No voice matches that under this language.')).toBeTruthy();
    });

    it('caps a long library at 60 rows and says how many it is hiding', () => {
      const voices: ModelEntry[] = Array.from({ length: 100 }, (_, i) => ({ id: `v-${i}`, name: `Voice ${i}`, note: i === 0 ? 'new' : undefined }));
      const big: ProviderEntry = { ...pickerProviders[2], voices };
      const { container } = render(<Harness initial={{ ...baseRig, voice: 'v-0' }} providers={[pickerProviders[0], pickerProviders[1], big]} />);
      expect(voiceRows(container)).toHaveLength(60);
      expect(screen.getByText('Showing 60 of 100 — narrow the search, or paste an id into the field below.')).toBeTruthy();
      expect(voiceRows(container)[0].querySelector('.tag')?.textContent).toBe('new');
      fireEvent.change(screen.getByPlaceholderText('search by name or id…'), { target: { value: 'Voice 9' } });
      // "Voice 9" and "Voice 90".."Voice 99"
      expect(voiceRows(container)).toHaveLength(11);
      expect(screen.queryByText(/Showing 60 of/)).toBeNull();
    });

    it('a vendor that takes ids offers a Voice id field; typing one overrides and disables the list', () => {
      const onChange = vi.fn();
      const { container } = render(<Harness initial={murfRig} providers={pickerProviders} onChange={onChange} />);
      const field = screen.getByLabelText(/Voice id/) as HTMLInputElement;
      expect(field.placeholder).toBe('en-US-natalie');
      expect(screen.getByText('Any Murf voice id.')).toBeTruthy();
      expect(screen.getByText(/wins over the list/)).toBeTruthy();
      fireEvent.change(field, { target: { value: 'en-IN-aarav' } });
      expect(lastRig(onChange)).toMatchObject({ customVoiceId: 'en-IN-aarav', voice: 'en-US-natalie' });
      expect(screen.getByText(/overridden by the voice id below/)).toBeTruthy();
      expect(voiceRows(container).every((r) => r.disabled)).toBe(true);
      expect((screen.getByPlaceholderText('search by name or id…') as HTMLInputElement).disabled).toBe(true);
      // Whitespace is not an override.
      fireEvent.change(field, { target: { value: '   ' } });
      expect(voiceRows(container).every((r) => !r.disabled)).toBe(true);
    });

    it('a vendor that takes ids but lists none still gets the field, with the default hint', () => {
      const bare: ProviderEntry = { ...pickerProviders[3], id: 'bare-tts', name: 'Bare', voiceIdHint: undefined,
        models: [{ id: 'b1', name: 'b1' }] };
      const { container } = render(<Harness initial={{ ...baseRig, ttsProviderId: 'bare-tts', ttsModelId: 'b1', voice: '' }} providers={[...pickerProviders.slice(0, 2), bare]} />);
      expect(container.querySelector('.voice-picker')).toBeNull();
      const field = screen.getByLabelText(/^Voice id/) as HTMLInputElement;
      expect(field.placeholder).toBe('voice id');
      expect(screen.getByText('Any id this vendor accepts. Leave blank to use the list above.')).toBeTruthy();
    });

    it('a vendor with no voices and no id field shows no voice controls', () => {
      const silent: ProviderEntry = { ...pickerProviders[2], voices: [] };
      const { container } = render(<Harness initial={baseRig} providers={[...pickerProviders.slice(0, 2), silent]} />);
      expect(container.querySelector('.voice-picker')).toBeNull();
      expect(screen.queryByLabelText(/Voice id/)).toBeNull();
    });

    it('the Sarvam leg offers no id field (it does not accept ids)', () => {
      render(<Harness initial={baseRig} providers={pickerProviders} />);
      expect(screen.queryByLabelText(/Voice id/)).toBeNull();
    });
  });

  describe('locked', () => {
    it('disables every control and says why', () => {
      const { container } = render(<Harness initial={murfRig} providers={pickerProviders} disabled />);
      expect(screen.getByText(/Locked while this rig is live/)).toBeTruthy();
      const controls = [...container.querySelectorAll('select, input, .p-chip, .voice-row')] as (HTMLInputElement | HTMLButtonElement)[];
      expect(controls.length).toBeGreaterThan(5);
      expect(controls.every((c) => c.disabled)).toBe(true);
      // Leaving is always possible.
      expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('script command', () => {
    it('prints the rig as the env command, prompt included', () => {
      const { container } = render(<Harness initial={baseRig} providers={pickerProviders} systemPrompt="Don't ramble." />);
      const pre = container.querySelector('pre.codeblock')!;
      expect(pre.textContent).toBe(envCommandOf(baseRig, pickerProviders, "Don't ramble."));
      expect(pre.textContent).toContain("SYSTEM='Don'\\''t ramble.' \\");
      expect(screen.getByRole('region', { name: 'Same rig as a script command' })).toBeTruthy();
      expect(container.textContent).not.toContain('Printed without the bench');
    });

    it('says so when printed without the prompt', () => {
      render(<Harness initial={baseRig} providers={pickerProviders} />);
      expect(screen.getByText(/Printed without the bench’s system prompt/)).toBeTruthy();
    });

    it('follows the rig as it is edited', () => {
      const { container } = render(<Harness initial={baseRig} providers={pickerProviders} systemPrompt="x" />);
      fireEvent.click(chip('TTS', 'Murf Falcon'));
      expect(container.querySelector('pre.codeblock')?.textContent).toContain('TTS=murf-tts TTS_MODEL=falcon-2 TTS_LANG=en-US VOICE=en-US-natalie');
    });

    it('copies through the clipboard and resets the label after a while', async () => {
      vi.useFakeTimers();
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      render(<Harness initial={baseRig} providers={pickerProviders} systemPrompt="p" />);
      const copy = within(screen.getByRole('region', { name: 'Same rig as a script command' })).getByRole('button');
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(writeText).toHaveBeenCalledWith(envCommandOf(baseRig, pickerProviders, 'p'));
      expect(copy.textContent).toBe('Copied');
      await act(async () => {
        vi.advanceTimersByTime(2400);
      });
      expect(copy.textContent).toBe('Copy');
    });

    it('selects the command instead of claiming a copy when the clipboard is missing or refuses', async () => {
      const selectAllChildren = vi.fn();
      vi.spyOn(window, 'getSelection').mockReturnValue({ selectAllChildren } as unknown as Selection);
      vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
      const { container } = render(<Harness initial={baseRig} providers={pickerProviders} />);
      const copy = within(screen.getByRole('region', { name: 'Same rig as a script command' })).getByRole('button');
      fireEvent.click(copy);
      expect(selectAllChildren).toHaveBeenCalledWith(container.querySelector('pre.codeblock'));
      expect(copy.textContent).toBe('Selected — press Ctrl/⌘+C');

      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) } });
      selectAllChildren.mockClear();
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(selectAllChildren).toHaveBeenCalledTimes(1);
      expect(copy.textContent).toBe('Selected — press Ctrl/⌘+C');
    });
  });
});
