import { useEffect, useRef, useState } from 'react';
import type { ProviderEntry } from '../lib/catalog';
import type { TurnRecord } from '../hooks/useVoiceSession';
import type { Rig } from '../lib/rigs';
import { envCommandOf, slotsOf } from '../lib/rigs';
import { bandsOf } from '../lib/legs';
import { medianOf } from '../lib/stats';
import { ms } from '../lib/format';

/**
 * The active rig, as a chain you read top to bottom in the order the audio
 * flows through it.
 *
 * The old picker was eight sibling dropdowns in a two-column grid — every
 * control the same size, no indication of which one was costing you time, and
 * no sign that a leg was missing its key until the session refused to start.
 * Here each leg carries its own measured latency and its own readiness, so the
 * rail answers "what is this rig, and what is wrong with it" without a click.
 */
export function RigRail({
  rig,
  providers,
  systemPrompt,
  turns,
  locked,
  onEdit,
  onRename,
  onDelete,
  canDelete,
}: {
  rig: Rig;
  providers: ProviderEntry[];
  /** Travels into the command block: a reproduction without it measures something else. */
  systemPrompt: string;
  turns: TurnRecord[];
  locked: boolean;
  onEdit: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const slots = slotsOf(rig, providers);
  const command = envCommandOf(rig, providers, systemPrompt);

  /** Median of this leg over the turns run so far, or nothing if it never reported. */
  const legMedian = (key: string): number | undefined =>
    medianOf(
      turns
        .map((t) => bandsOf(t.derived, t.marks).find((b) => b.key === key)?.ms)
        .filter((v): v is number => v !== undefined),
    );

  // Cleared on unmount: switching to Compare inside the window would otherwise
  // set state on a component that is gone.
  const resetTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = () => {
    // `navigator.clipboard` is undefined on a non-secure origin. Saying "copied"
    // when nothing was copied is worse than saying nothing.
    const written = navigator.clipboard?.writeText(command);
    if (!written) return;
    void written.then(() => {
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <section className="panel">
      <h2>
        Rig
        <input
          className="rig-name"
          value={rig.name}
          disabled={locked}
          spellCheck={false}
          aria-label="Rig name"
          onChange={(e) => onRename(e.target.value)}
        />
        <span className="right">
          <button type="button" className="ghost inline" onClick={onEdit}>
            edit
          </button>
          {canDelete && (
            <button type="button" className="ghost inline danger" disabled={locked} onClick={onDelete}>
              delete
            </button>
          )}
        </span>
      </h2>

      <div className="leg-rail">
        {slots.map((slot) => {
          // A realtime rig's single leg is timed in the TTS slot: the whole
          // model is what stands between t0 and the first audio byte.
          const measured = legMedian(slot.key === 'realtime' ? 'tts' : slot.key);
          return (
            <button key={slot.key} type="button" className="leg" onClick={onEdit}>
              <span className="leg-key">
                {slot.label}
                <i className="leg-bar" style={{ background: slot.color }} />
              </span>
              <span className="leg-body">
                <span className="leg-name">{slot.providerName}</span>
                <span className="leg-model mono">{slot.modelId || '—'}</span>
              </span>
              <span className="leg-ms">{measured !== undefined ? `${ms(measured)} ms` : ''}</span>
              <span
                className={`rdy ${slot.ready ? '' : 'miss'}`}
                title={slot.blocker ?? 'registered, and every key it needs is present'}
              />
            </button>
          );
        })}
      </div>

      {slots.some((s) => !s.ready) && (
        <p className="banner warn inline-banner">
          {slots
            .filter((s) => !s.ready)
            .map((s) => `${s.label}: ${s.blocker}`)
            .join(' · ')}
        </p>
      )}

      <div className="rig-meta">
        <span>
          <span className="field-label">Language</span>
          <code className="mono">{(rig.mode === 'realtime' ? rig.language : rig.ttsLanguage) || '—'}</code>
        </span>
        <span>
          <span className="field-label">Voice</span>
          <code className="mono">{rig.customVoiceId.trim() || rig.voice || '—'}</code>
        </span>
      </div>

      {/*
        The same rig as the environment variables this repo's own scripts take.
        The bench and the CLI measure the same thing; there is no reason
        reproducing a result from one in the other should be retyping.
      */}
      <div className="cmd">
        <button type="button" className="cmd-copy" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
        {command}
      </div>
    </section>
  );
}
