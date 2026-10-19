import { Fragment } from 'react';
import type { ProviderEntry } from '../lib/catalog';
import type { TurnRecord } from '../hooks/useVoiceSession';
import type { Rig, RigSlot } from '../lib/rigs';
import { envCommandOf, slotsOf } from '../lib/rigs';
import { bandsOf } from '../lib/legs';
import { medianOf } from '../lib/stats';
import { ms } from '../lib/format';
import { Icon } from './Icon';

const STAGE: Record<RigSlot['key'], { title: string; measures: string }> = {
  stt: { title: 'Speech to text', measures: 'to final transcript' },
  llm: { title: 'Language model', measures: 'to first token' },
  tts: { title: 'Text to speech', measures: 'to first byte' },
  realtime: { title: 'Speech to speech', measures: 'to first audio byte' },
};

/**
 * The active rig as a signal chain, read left to right in the order the audio
 * flows through it.
 *
 * The old picker was eight sibling dropdowns in a two-column grid — every
 * control the same size, no indication of which one was costing you time, and
 * no sign that a leg was missing its key until the session refused to start.
 * Here each leg carries its own measured latency and its own readiness, so the
 * chain answers "what is this rig, and what is wrong with it" without a click.
 */
export function RigRail({
  rig,
  providers,
  systemPrompt,
  turns,
  locked,
  onEdit,
  commandOpen,
  onCommandOpenChange,
}: {
  rig: Rig;
  providers: ProviderEntry[];
  /** Travels into the command block: a reproduction without it measures something else. */
  systemPrompt: string;
  turns: TurnRecord[];
  locked: boolean;
  onEdit: () => void;
  /** Controlled so a failed clipboard write upstream can open the command for manual copying. */
  commandOpen?: boolean;
  onCommandOpenChange?: (open: boolean) => void;
}) {
  const slots = slotsOf(rig, providers);
  const command = envCommandOf(rig, providers, systemPrompt);

  /** Median of this leg over the turns run so far, or nothing if it never reported. */
  const legMedian = (key: RigSlot['key']): number | undefined =>
    medianOf(
      turns
        .map((t) =>
          // A realtime provider never marks a TTS request: the whole model is
          // what stands between t0 and the first audio byte, so its one leg is
          // the turn's time to first audio.
          key === 'realtime'
            ? t.derived.timeToFirstAudioMs
            : bandsOf(t.derived, t.marks).find((b) => b.key === key)?.ms,
        )
        .filter((v): v is number => v !== undefined),
    );

  // The same voice rule the command uses: a typed voice id only counts for a
  // vendor that takes ids the dropdown cannot enumerate.
  const voiceOwner = providers.find(
    (p) => p.id === (rig.mode === 'realtime' ? rig.realtimeProviderId : rig.ttsProviderId),
  );
  const voice = (voiceOwner?.acceptsVoiceId && rig.customVoiceId.trim()) || rig.voice;

  const detailOf = (slot: RigSlot): string | undefined => {
    if (slot.key === 'stt') return `language ${rig.sttLanguage || 'default'}`;
    if (slot.key === 'tts') return `voice ${voice || 'default'} · language ${rig.ttsLanguage || 'default'}`;
    if (slot.key === 'realtime') return `voice ${voice || 'default'} · language ${rig.language || 'default'}`;
    return undefined;
  };

  return (
    <div className="chain-wrap">
      <section className="chain" aria-label="Signal chain">
        {slots.map((slot, i) => {
          const stage = STAGE[slot.key];
          const entry = providers.find((p) => p.id === slot.providerId);
          const measured = legMedian(slot.key);
          const detail = detailOf(slot);
          return (
            <Fragment key={slot.key}>
              {i > 0 && (
                <span className="chain-arrow" aria-hidden="true">
                  <Icon name="arrowRight" size={18} />
                </span>
              )}
              <button
                type="button"
                className="chain-card"
                onClick={onEdit}
                disabled={locked}
                title={locked ? 'End the conversation to edit this rig' : `Edit ${stage.title.toLowerCase()}`}
              >
                <span className="chain-head">
                  <span className="chain-stage">
                    <i className="chain-swatch" style={{ background: slot.color }} />
                    {slots.length > 1 ? `${i + 1} · ${stage.title}` : stage.title}
                  </span>
                  {slot.ready ? (
                    <span className="chain-ready ok">
                      <Icon name="check" size={14} />
                      {entry && entry.envKeys.length === 0 ? 'No key needed' : 'Key set'}
                    </span>
                  ) : (
                    <span className="chain-ready miss">
                      <Icon name="alert" size={14} />
                      {slot.blocker}
                    </span>
                  )}
                </span>
                <span className="chain-body">
                  <span className="chain-provider">{slot.providerName}</span>
                  <span className="chain-model mono">{[slot.modelId || '—', detail].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="chain-foot">
                  {measured !== undefined ? (
                    <>
                      <span className="chain-ms">{ms(measured)}</span>
                      <span className="muted">{`ms · median, ${stage.measures}`}</span>
                    </>
                  ) : (
                    <>
                      <span className="chain-ms">—</span>
                      <span className="muted">no turns yet</span>
                    </>
                  )}
                </span>
              </button>
            </Fragment>
          );
        })}
      </section>

      {/*
        The same rig as the environment variables this repo's own scripts take.
        The bench and the CLI measure the same thing; there is no reason
        reproducing a result from one in the other should be retyping.
      */}
      <details
        className="chain-cmd"
        open={commandOpen}
        onToggle={(e) => onCommandOpenChange?.(e.currentTarget.open)}
      >
        <summary>
          <Icon name="terminal" size={14} />
          Show CLI command
        </summary>
        <pre className="cmd">{command}</pre>
      </details>
    </div>
  );
}
