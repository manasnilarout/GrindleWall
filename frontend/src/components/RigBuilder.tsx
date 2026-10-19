import { useEffect, useId, useRef, useState } from 'react';
import { languagesFor, voicesFor, type ModelEntry, type ProviderEntry, type ProviderKind } from '../lib/catalog';
import { LEG_BANDS } from '../lib/legs';
import type { SessionMode } from '../lib/protocol';
import type { Rig } from '../lib/rigs';
import {
  envCommandOf,
  rigColor,
  rigLetter,
  switchMode,
  switchProvider,
  switchSttModel,
  switchVoicedLanguage,
  switchVoicedModel,
} from '../lib/rigs';
import { Select } from './Select';
import { TextField } from './TextField';
import { Icon } from './Icon';

/**
 * The rig editor.
 *
 * Everything here about *why* a control changes another control is behaviour of
 * the vendors, not of this UI, and it is all load-bearing — the comments below
 * each mark a live 400 someone had to debug. The change from the old picker is
 * presentational: the constraint is now written next to the control that caused
 * it, and provider choice is a row of chips carrying readiness rather than
 * `<option>` text nobody reads.
 */
export function RigBuilder({
  rig,
  providers,
  disabled,
  systemPrompt,
  onChange,
  onClose,
}: {
  rig: Rig;
  providers: ProviderEntry[];
  disabled: boolean;
  /**
   * The bench's prompt, for the script command. Optional only until App passes
   * it: without it the command is printed without `SYSTEM`, and says so.
   */
  systemPrompt?: string;
  onChange: (next: Rig) => void;
  onClose: () => void;
}) {
  const byKind = (kind: ProviderKind) => providers.filter((p) => p.kind === kind);
  const find = (id: string) => providers.find((p) => p.id === id);

  const modelOptions = (providerId: string) =>
    (find(providerId)?.models ?? []).map((m) => ({ id: m.id, name: m.name, hint: m.note }));

  const languageOptions = (providerId: string, modelId: string) =>
    languagesFor(providers, providerId, modelId).map((l) => ({ id: l.id, name: l.name }));

  /** Voices come from the realtime provider, or from the TTS provider in pipeline mode. */
  const voiceSource = rig.mode === 'realtime' ? find(rig.realtimeProviderId) : find(rig.ttsProviderId);
  /** …and from the selected model, and the language under it. */
  const voiceOptions =
    rig.mode === 'realtime'
      ? voicesFor(providers, rig.realtimeProviderId, rig.realtimeModelId, rig.language)
      : voicesFor(providers, rig.ttsProviderId, rig.ttsModelId, rig.ttsLanguage);
  /** A typed id wins over the list — the same rule the start config applies. */
  const usingCustomVoice = Boolean(voiceSource?.acceptsVoiceId && rig.customVoiceId.trim());

  /*
   * Every transition below is a pure rule in `lib/rigs.ts`, not logic living in
   * this component. Each marks a live vendor error someone had to debug, and
   * keeping them callable is what lets `render-check` prove they still hold —
   * the same reason `resolveVoice` was extracted before them.
   */
  const setProvider = (kind: ProviderKind, id: string) => onChange(switchProvider(rig, providers, kind, id));
  const setMode = (mode: SessionMode) => onChange(switchMode(rig, providers, mode));
  const setVoicedModel = (kind: 'realtime' | 'tts', modelId: string) =>
    onChange(switchVoicedModel(rig, providers, kind, modelId));
  const setVoicedLanguage = (kind: 'realtime' | 'tts', languageId: string) =>
    onChange(switchVoicedLanguage(rig, providers, kind, languageId));

  const panelRef = useRef<HTMLDivElement>(null);
  const archName = useId();
  /**
   * Where the gesture that is about to close the drawer STARTED.
   *
   * Closing on the scrim's `click` alone was wrong: a drag that begins inside —
   * selecting text in the voice search, a mis-drag across the 934-row voice
   * list — releases over the scrim, and `click` fires on the common ancestor,
   * which is the scrim. The drawer closed mid-edit. A dismissal now has to both
   * start and end on the scrim.
   */
  const downOnScrim = useRef(false);

  useEffect(() => {
    // Escape is the expected way out of a modal; before this the only keyboard
    // exit was tabbing all the way to Done.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const [stt, llm, tts] = LEG_BANDS;

  const voice = (voiceOptions.length > 0 || voiceSource?.acceptsVoiceId) && (
    <>
      {voiceOptions.length > 0 && (
        <VoicePicker
          voices={voiceOptions}
          value={rig.voice}
          disabled={disabled || usingCustomVoice}
          overridden={usingCustomVoice}
          onChange={(id) => onChange({ ...rig, voice: id })}
        />
      )}
      {voiceSource?.acceptsVoiceId && (
        <TextField
          label="Voice id"
          note={voiceOptions.length > 0 ? 'wins over the list' : undefined}
          value={rig.customVoiceId}
          placeholder={voiceOptions[0]?.id ?? 'voice id'}
          hint={voiceSource.voiceIdHint ?? 'Any id this vendor accepts. Leave blank to use the list above.'}
          onChange={(v) => onChange({ ...rig, customVoiceId: v })}
          disabled={disabled}
          mono
        />
      )}
    </>
  );

  return (
    <div
      className="drawer-scrim"
      onMouseDown={(e) => {
        downOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnScrim.current) onClose();
      }}
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${rig.name}`}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="sheet-head">
          <span className="sheet-badge" style={{ background: rigColor(rig) }} aria-hidden="true">
            {rigLetter(rig)}
          </span>
          <span className="sheet-title">
            <span className="eyebrow">Edit rig</span>
            <h1>{rig.name}</h1>
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
          <button type="button" className="ghost icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="sheet-body">
          {disabled && (
            <p className="banner warn inline-banner sheet-lock">
              <Icon name="lock" size={14} />
              Locked while this rig is live. End the session to change it; swapping a leg under a connected socket would
              file the numbers against a combination that never produced them.
            </p>
          )}

          <fieldset className="arch" disabled={disabled}>
            <legend className="field-label">Architecture</legend>
            <div className="arch-cards">
              {(
                [
                  ['pipeline', 'Pipeline', 'STT → LLM → TTS, one vendor per leg'],
                  ['realtime', 'Realtime', 'One speech-to-speech model'],
                ] as const
              ).map(([m, name, sub]) => (
                <label key={m} className={`arch-card ${rig.mode === m ? 'on' : ''}`}>
                  <input
                    type="radio"
                    name={archName}
                    value={m}
                    checked={rig.mode === m}
                    disabled={disabled}
                    onChange={() => setMode(m)}
                  />
                  <span className="arch-copy">
                    <b>{name}</b>
                    <span>{sub}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {rig.mode === 'realtime' ? (
            <LegSection
              step={1}
              color={tts.color}
              title="Speech to speech"
              kind="Realtime"
              hint="One model does the listening, the thinking and the speaking. There are no legs to profile inside it — when it is slow, the model is the only dial."
              providers={byKind('realtime')}
              selected={rig.realtimeProviderId}
              disabled={disabled}
              onPick={(id) => setProvider('realtime', id)}
            >
              <div className="grid">
                <Select
                  label="Model"
                  value={rig.realtimeModelId}
                  options={modelOptions(rig.realtimeProviderId)}
                  onChange={(id) => setVoicedModel('realtime', id)}
                  disabled={disabled}
                  mono
                />
                {languageOptions(rig.realtimeProviderId, rig.realtimeModelId).length > 0 && (
                  <Select
                    label="Language"
                    value={rig.language}
                    options={languageOptions(rig.realtimeProviderId, rig.realtimeModelId)}
                    onChange={(id) => setVoicedLanguage('realtime', id)}
                    disabled={disabled}
                  />
                )}
              </div>
              {voice}
            </LegSection>
          ) : (
            <>
              <LegSection
                step={1}
                color={stt.color}
                title="Speech to text"
                kind="STT"
                hint="Where t0 comes from. A vendor that publishes its own speech_end event supplies it; the rest fall back to the local energy detector."
                providers={byKind('stt')}
                selected={rig.sttProviderId}
                disabled={disabled}
                onPick={(id) => setProvider('stt', id)}
              >
                <div className="grid">
                  <Select
                    label="Model"
                    value={rig.sttModelId}
                    options={modelOptions(rig.sttProviderId)}
                    onChange={(id) => onChange(switchSttModel(rig, providers, id))}
                    disabled={disabled}
                    mono
                  />
                  {languageOptions(rig.sttProviderId, rig.sttModelId).length > 0 && (
                    <Select
                      label="Language"
                      value={rig.sttLanguage}
                      options={languageOptions(rig.sttProviderId, rig.sttModelId)}
                      onChange={(id) => onChange({ ...rig, sttLanguage: id })}
                      disabled={disabled}
                    />
                  )}
                </div>
              </LegSection>

              <LegSection
                step={2}
                color={llm.color}
                title="Language model"
                kind="LLM"
                hint="A deeper variant spends tokens thinking before it answers, billed at the output rate, so it costs both latency and money. How much depends on the model; run the same prompt at two variants and read the report."
                providers={byKind('llm')}
                selected={rig.llmProviderId}
                disabled={disabled}
                onPick={(id) => setProvider('llm', id)}
              >
                <Select
                  label="Model"
                  value={rig.llmModelId}
                  options={modelOptions(rig.llmProviderId)}
                  onChange={(id) => onChange({ ...rig, llmModelId: id })}
                  disabled={disabled}
                  mono
                  // Absent rather than greyed out, so the UI cannot produce a 400.
                  hint="The part after @ is the thinking level; only measured combinations are listed."
                />
              </LegSection>

              <LegSection
                step={3}
                color={tts.color}
                title="Text to speech"
                kind="TTS"
                hint="Voices narrow provider → model → language, in that order, because vendors genuinely differ at each step."
                providers={byKind('tts')}
                selected={rig.ttsProviderId}
                disabled={disabled}
                onPick={(id) => setProvider('tts', id)}
              >
                <div className="grid">
                  <Select
                    label="Model"
                    value={rig.ttsModelId}
                    options={modelOptions(rig.ttsProviderId)}
                    onChange={(id) => setVoicedModel('tts', id)}
                    disabled={disabled}
                    mono
                  />
                  {languageOptions(rig.ttsProviderId, rig.ttsModelId).length > 0 && (
                    <Select
                      label="Language"
                      note={`${languageOptions(rig.ttsProviderId, rig.ttsModelId).length} on this model`}
                      value={rig.ttsLanguage}
                      options={languageOptions(rig.ttsProviderId, rig.ttsModelId)}
                      onChange={(id) => setVoicedLanguage('tts', id)}
                      disabled={disabled}
                    />
                  )}
                </div>
                {voice}
              </LegSection>
            </>
          )}

          <ScriptCommand command={envCommandOf(rig, providers, systemPrompt)} withPrompt={systemPrompt !== undefined} />
        </div>
      </div>
    </div>
  );
}

/** One leg: a numbered heading in the leg's colour, its providers as chips carrying readiness, then the model controls. */
function LegSection({
  step,
  color,
  title,
  kind,
  hint,
  providers,
  selected,
  disabled,
  onPick,
  children,
}: {
  step: number;
  /** From `LEG_BANDS`, so the step reads as the same leg the latency charts draw. */
  color: string;
  title: string;
  /** Short name for the radio group: "STT provider". */
  kind: string;
  hint: string;
  providers: ProviderEntry[];
  selected: string;
  disabled: boolean;
  onPick: (id: string) => void;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="leg-section" aria-labelledby={headingId}>
      <h2 id={headingId}>
        <span className="leg-step" style={{ background: color }} aria-hidden="true">
          {step}
        </span>
        {title}
      </h2>
      <div className="p-chips" role="radiogroup" aria-label={`${kind} provider`}>
        {providers.map((p) => {
          // Not registered means the factory will refuse it outright, so it is
          // unpickable. A missing key means it will refuse it on start — still
          // pickable, so a rig can be laid out before the key is in `.env`, but
          // the chip names the key so the fix is obvious.
          const blocked = !p.registered;
          const missing = p.missingEnv.length > 0;
          const on = p.id === selected;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`p-chip ${on ? 'on' : ''} ${blocked ? 'off' : missing ? 'miss' : ''}`}
              disabled={disabled || blocked}
              title={blocked ? 'Not wired up in factory.ts yet' : missing ? `Needs ${p.missingEnv.join(', ')} in backend/.env` : p.id}
              onClick={() => onPick(p.id)}
            >
              {on ? <Icon name="check" size={14} className="p-check" /> : !blocked && <i className="k" aria-hidden="true" />}
              {p.name}
              {blocked ? (
                <span className="p-note">· not wired</span>
              ) : (
                missing && (
                  <span className="p-note">
                    Needs <code>{p.missingEnv[0]}</code>
                    {p.missingEnv.length > 1 ? ` +${p.missingEnv.length - 1}` : ''}
                  </span>
                )
              )}
            </button>
          );
        })}
      </div>
      {children}
      <p className="foot">{hint}</p>
    </section>
  );
}

/**
 * The rig as the environment variables the repo's scripts take, so a number
 * seen here can be re-measured from the terminal.
 */
function ScriptCommand({ command, withPrompt }: { command: string; withPrompt: boolean }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'selected'>('idle');
  const preRef = useRef<HTMLPreElement>(null);
  const resetTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const settle = (state: 'copied' | 'selected') => {
    setCopyState(state);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 2400);
  };
  // `navigator.clipboard` is undefined on a non-secure origin. Saying "Copied"
  // when nothing was copied is worse than saying nothing, so the command is
  // selected instead and the button says that.
  const select = () => {
    const pre = preRef.current;
    const selection = window.getSelection();
    if (!pre || !selection) return;
    selection.selectAllChildren(pre);
    settle('selected');
  };
  const copy = () => {
    const written = navigator.clipboard?.writeText(command);
    if (!written) return select();
    void written.then(() => settle('copied'), select);
  };

  return (
    <section className="sheet-cli" aria-label="Same rig as a script command">
      <div className="sheet-cli-head">
        <h2 className="field-label">Same rig as a script command</h2>
        <button type="button" className="ghost inline" onClick={copy}>
          <Icon name="copy" size={14} />
          {copyState === 'copied' ? 'Copied' : copyState === 'selected' ? 'Selected — press Ctrl/⌘+C' : 'Copy'}
        </button>
      </div>
      <pre className="codeblock" ref={preRef}>
        {command}
      </pre>
      <p className="foot">
        Run from <code>backend/</code> with <code>npm run dev</code> up.
        {!withPrompt && ' Printed without the bench’s system prompt — add SYSTEM=… or it measures smoke’s default prompt.'}
      </p>
    </section>
  );
}

/**
 * A searchable voice list.
 *
 * Cartesia files 934 voices under 44 languages, which a `<select>` renders as
 * 934 `<option>` elements you scroll with a mouse wheel. The list is capped at
 * what fits and says how many it is hiding, so a long library is navigable
 * rather than merely present.
 */
function VoicePicker({
  voices,
  value,
  disabled,
  overridden,
  onChange,
}: {
  voices: ModelEntry[];
  value: string;
  disabled: boolean;
  overridden: boolean;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = q
    ? voices.filter((v) => v.name.toLowerCase().includes(q) || v.id.toLowerCase().includes(q))
    : voices;
  const CAP = 60;
  const shown = matches.slice(0, CAP);

  return (
    <div className={`voice-picker ${disabled ? 'is-disabled' : ''}`}>
      <label className="field">
        <span className="field-label">
          Voice
          <span className="field-note">
            {' '}
            · {voices.length} available{overridden ? ' — overridden by the voice id below' : ''}
          </span>
        </span>
        <span className="voice-search">
          <Icon name="search" size={15} />
          <input
            type="text"
            value={query}
            spellCheck={false}
            disabled={disabled}
            placeholder="search by name or id…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
      </label>

      <div className="voice-list">
        {shown.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`voice-row ${v.id === value ? 'on' : ''}`}
            aria-pressed={v.id === value}
            disabled={disabled}
            onClick={() => onChange(v.id)}
          >
            <span className="voice-name">{v.name}</span>
            {v.note && <span className="tag">{v.note}</span>}
            <span className="id mono">{v.id}</span>
          </button>
        ))}
        {shown.length === 0 && <p className="muted small pad">No voice matches that under this language.</p>}
      </div>

      {matches.length > CAP && (
        <p className="foot">
          Showing {CAP} of {matches.length} — narrow the search, or paste an id into the field below.
        </p>
      )}
    </div>
  );
}
