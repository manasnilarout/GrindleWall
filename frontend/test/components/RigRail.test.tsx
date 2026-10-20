// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RigRail } from '../../src/components/RigRail';
import type { ProviderEntry } from '../../src/lib/catalog';
import { envCommandOf } from '../../src/lib/rigs';
import { baseRig, murfRig, novaProviders, novaRig, pickerProviders, pipelineTurn, realtimeTurn, slowTurn } from './fixtures';

const props = (over: Partial<Parameters<typeof RigRail>[0]> = {}): Parameters<typeof RigRail>[0] => ({
  rig: baseRig, providers: pickerProviders, systemPrompt: 'Be brief.', turns: [], locked: false, onEdit: vi.fn(), ...over,
});
const cards = (c: HTMLElement) => [...c.querySelectorAll('.chain-card')] as HTMLButtonElement[];

describe('RigRail', () => {
  it('draws a pipeline as three numbered cards in wire order with arrows between', () => {
    const { container } = render(<RigRail {...props()} />);
    expect(screen.getByRole('region', { name: 'Signal chain' })).toBeTruthy();
    const c = cards(container);
    expect(c.map((x) => x.querySelector('.chain-stage')?.textContent)).toEqual([
      '1 · Speech to text', '2 · Language model', '3 · Text to speech',
    ]);
    expect(c.map((x) => x.querySelector('.chain-provider')?.textContent)).toEqual(['Mock (canned)', 'Mock (echo)', 'Sarvam Bulbul']);
    expect(c.map((x) => x.querySelector('.chain-model')?.textContent)).toEqual([
      'mock-asr · language default', 'mock-chat', 'bulbul:v3 · voice priya · language en-IN',
    ]);
    expect(container.querySelectorAll('.chain-arrow')).toHaveLength(2);
    // Readiness per leg.
    expect(c[0].querySelector('.chain-ready')?.textContent).toBe('No key needed');
    expect(c[2].querySelector('.chain-ready')?.textContent).toBe('Key set');
    expect(c.every((x) => x.querySelector('.chain-foot')?.textContent === '—no turns yet')).toBe(true);
    expect(c[0].getAttribute('title')).toBe('Edit speech to text');
  });

  it('every card opens the editor', () => {
    const p = props();
    const { container } = render(<RigRail {...p} />);
    for (const card of cards(container)) fireEvent.click(card);
    expect(p.onEdit).toHaveBeenCalledTimes(3);
  });

  it('carries each leg median once turns land', () => {
    const { container } = render(<RigRail {...props({ turns: [pipelineTurn, slowTurn] })} />);
    const feet = cards(container).map((x) => x.querySelector('.chain-foot')?.textContent);
    expect(feet).toEqual([
      '214ms · median, to final transcript',
      '148ms · median, to first token',
      '972ms · median, to first byte',
    ]);
  });

  it('a realtime rig is one un-numbered card timed to first audio', () => {
    const { container, rerender } = render(<RigRail {...props({ rig: novaRig, providers: novaProviders })} />);
    const c = cards(container);
    expect(c).toHaveLength(1);
    expect(c[0].querySelector('.chain-stage')?.textContent).toBe('Speech to speech');
    expect(c[0].querySelector('.chain-model')?.textContent).toBe('amazon.nova-2-sonic-v1:0 · voice kiara · language en-IN');
    expect(container.querySelector('.chain-arrow')).toBeNull();
    rerender(<RigRail {...props({ rig: novaRig, providers: novaProviders, turns: [realtimeTurn] })} />);
    expect(cards(container)[0].querySelector('.chain-foot')?.textContent).toBe('441ms · median, to first audio byte');
  });

  it('a typed voice id shows only for a vendor that takes ids', () => {
    const { container, rerender } = render(<RigRail {...props({ rig: { ...murfRig, customVoiceId: ' en-IN-aarav ' } })} />);
    expect(cards(container)[2].querySelector('.chain-model')?.textContent).toBe('falcon-2 · voice en-IN-aarav · language en-US');
    rerender(<RigRail {...props({ rig: { ...baseRig, customVoiceId: 'ignored' } })} />);
    expect(cards(container)[2].querySelector('.chain-model')?.textContent).toBe('bulbul:v3 · voice priya · language en-IN');
  });

  it('surfaces a missing key, an unwired provider and one missing from the catalog on the card', () => {
    const providers: ProviderEntry[] = [
      ...pickerProviders.filter((p) => p.kind !== 'llm'),
      { id: 'groq-llm', name: 'Groq', kind: 'llm', implemented: true, registered: true, ready: false,
        envKeys: ['GROQ_API_KEY'], missingEnv: ['GROQ_API_KEY'], models: [{ id: 'llama-3.3-70b', name: 'llama' }] },
      { id: 'deepgram-tts', name: 'Deepgram', kind: 'tts', implemented: false, registered: false, ready: false,
        envKeys: [], missingEnv: [], models: [] },
    ];
    const rig = { ...baseRig, sttProviderId: 'gone-stt', llmProviderId: 'groq-llm', llmModelId: 'llama-3.3-70b', ttsProviderId: 'deepgram-tts' };
    const { container } = render(<RigRail {...props({ rig, providers })} />);
    const ready = cards(container).map((x) => x.querySelector('.chain-ready'));
    expect(ready.map((r) => r?.className)).toEqual(['chain-ready miss', 'chain-ready miss', 'chain-ready miss']);
    expect(ready.map((r) => r?.textContent)).toEqual(['not in the catalog', 'needs GROQ_API_KEY', 'not wired up']);
    expect(cards(container)[0].querySelector('.chain-provider')?.textContent).toBe('gone-stt');
  });

  it('shows "—" for a slot with no model', () => {
    const { container } = render(<RigRail {...props({ rig: { ...baseRig, llmModelId: '' } })} />);
    expect(cards(container)[1].querySelector('.chain-model')?.textContent).toBe('—');
  });

  it('locks every card during a live session and says why', () => {
    const { container } = render(<RigRail {...props({ locked: true })} />);
    for (const card of cards(container)) {
      expect(card.disabled).toBe(true);
      expect(card.getAttribute('title')).toBe('End the conversation to edit this rig');
    }
  });

  it('carries the exact CLI command, system prompt included', () => {
    const { container } = render(<RigRail {...props()} />);
    const cmd = container.querySelector('pre.cmd')?.textContent;
    expect(cmd).toBe(
      [
        "STT=mock-stt STT_MODEL=mock-asr STT_LANG='' \\",
        'LLM=mock-llm LLM_MODEL=mock-chat \\',
        'TTS=sarvam-tts TTS_MODEL=bulbul:v3 TTS_LANG=en-IN VOICE=priya \\',
        "SYSTEM='Be brief.' \\",
        '  node scripts/smoke.mjs pipeline',
      ].join('\n'),
    );
    expect(cmd).toBe(envCommandOf(baseRig, pickerProviders, 'Be brief.'));
    expect(screen.getByText('Show CLI command')).toBeTruthy();
  });

  it('a realtime command uses REALTIME/REALTIME_MODEL/VOICE/LANG_CODE and no SYSTEM for an empty prompt', () => {
    const { container } = render(<RigRail {...props({ rig: novaRig, providers: novaProviders, systemPrompt: '  ' })} />);
    expect(container.querySelector('pre.cmd')?.textContent).toBe(
      ['REALTIME=aws-nova-sonic REALTIME_MODEL=amazon.nova-2-sonic-v1:0 \\', 'VOICE=kiara LANG_CODE=en-IN \\', '  node scripts/smoke.mjs realtime'].join('\n'),
    );
  });

  it('the command disclosure is controlled from above and reports toggles', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<RigRail {...props({ commandOpen: false, onCommandOpenChange: onChange })} />);
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    rerender(<RigRail {...props({ commandOpen: true, onCommandOpenChange: onChange })} />);
    expect(details.open).toBe(true);
    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});
