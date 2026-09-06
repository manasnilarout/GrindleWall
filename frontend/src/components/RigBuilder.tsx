import { useEffect, useRef, useState } from 'react';
import { languagesFor, voicesFor, type ModelEntry, type ProviderEntry, type ProviderKind } from '../lib/catalog';
import type { SessionMode } from '../lib/protocol';
import type { Rig } from '../lib/rigs';
import { switchMode, switchProvider, switchSttModel, switchVoicedLanguage, switchVoicedModel } from '../lib/rigs';
import { Select } from './Select';
import { TextField } from './TextField';
import { Icon, type IconName } from './Icon';

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
  onChange,
  onClose,
}: {
  rig: Rig;
  providers: ProviderEntry[];
  disabled: boolean;
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
        <div className="drawer-head">
          <h1>
            <Icon name="hat" size={16} />
            {rig.name}
          </h1>
          <span className="muted small">
            {rig.mode === 'realtime' ? 'one speech-to-speech model' : 'three legs, three vendors'}
          </span>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={onClose}>
            <Icon name="wand" size={13} />
            Done
          </button>
        </div>

        <div className="drawer-body">
          <div className="seg wide" role="radiogroup" aria-label="Architecture">
            {(['pipeline', 'realtime'] as SessionMode[]).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={rig.mode === m}
                className={rig.mode === m ? 'on' : ''}
                disabled={disabled}
                onClick={() => setMode(m)}
              >
                {m === 'realtime' ? 'Realtime · speech-to-speech' : 'Pipeline · STT → LLM → TTS'}
              </button>
            ))}
          </div>

          {rig.mode === 'realtime' ? (
            <SlotSection
              title="Speech-to-speech"
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
            </SlotSection>
          ) : (
            <>
              <SlotSection
                title="STT"
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
              </SlotSection>

              <SlotSection
                title="LLM"
                hint="Reasoning depth is encoded in the model id as an @variant, and it is billed at the output rate — a deeper variant spends tokens on thinking before it answers, so it costs both latency and money. How much depends on the model; run the same prompt at two variants and read the report."
                providers={byKind('llm')}
                selected={rig.llmProviderId}
                disabled={disabled}
                onPick={(id) => setProvider('llm', id)}
              >
                <div className="grid">
                  <Select
                    label="Model"
                    value={rig.llmModelId}
                    options={modelOptions(rig.llmProviderId)}
                    onChange={(id) => onChange({ ...rig, llmModelId: id })}
                    disabled={disabled}
                    hint="Only verified combinations are listed — an unsupported variant is absent rather than greyed out, so the UI cannot produce a 400."
                  />
                </div>
              </SlotSection>

              <SlotSection
                title="TTS"
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
                  />
                  {languageOptions(rig.ttsProviderId, rig.ttsModelId).length > 0 && (
                    <Select
                      label="Language"
                      value={rig.ttsLanguage}
                      options={languageOptions(rig.ttsProviderId, rig.ttsModelId)}
                      onChange={(id) => setVoicedLanguage('tts', id)}
                      disabled={disabled}
                      hint={`${languageOptions(rig.ttsProviderId, rig.ttsModelId).length} on this model`}
                    />
                  )}
                </div>
              </SlotSection>
            </>
          )}

          {(voiceOptions.length > 0 || voiceSource?.acceptsVoiceId) && (
            <section className="slot">
              <h3>Voice</h3>
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
                  value={rig.customVoiceId}
                  placeholder={voiceOptions[0]?.id ?? 'voice id'}
                  hint={voiceSource.voiceIdHint ?? 'Any id this vendor accepts. Leave blank to use the list above.'}
                  onChange={(v) => onChange({ ...rig, customVoiceId: v })}
                  disabled={disabled}
                />
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

const SLOT_ICON: Record<string, IconName> = {
  'Speech-to-speech': 'lightning',
  STT: 'mic',
  LLM: 'crystal',
  TTS: 'owl',
};

/** One leg: its providers as chips carrying readiness, then the model controls. */
function SlotSection({
  title,
  hint,
  providers,
  selected,
  disabled,
  onPick,
  children,
}: {
  title: string;
  hint: string;
  providers: ProviderEntry[];
  selected: string;
  disabled: boolean;
  onPick: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="slot">
      <h3>
        <Icon name={SLOT_ICON[title] ?? 'sparkle'} size={13} />
        {title}
      </h3>
      <div className="p-chips">
        {providers.map((p) => {
          // Not registered means the factory will refuse it outright; a missing
          // key means it will refuse it on start. Both are unpickable, and the
          // chip says which so the fix is obvious.
          const blocked = !p.registered;
          const missing = p.missingEnv.length > 0;
          return (
            <button
              key={p.id}
              type="button"
              className={`p-chip ${p.id === selected ? 'on' : ''} ${blocked ? 'off' : ''}`}
              disabled={disabled || blocked}
              title={blocked ? 'not wired up in factory.ts' : missing ? `needs ${p.missingEnv.join(', ')}` : p.id}
              onClick={() => onPick(p.id)}
            >
              <i className={`k ${blocked ? 'no' : missing ? 'miss' : ''}`} />
              {p.name}
            </button>
          );
        })}
      </div>
      {children}
      <p className="muted small foot">{hint}</p>
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
          {voices.length} available{overridden ? ' — overridden by the voice id below' : ''}
        </span>
        <input
          type="text"
          value={query}
          spellCheck={false}
          disabled={disabled}
          placeholder="search by name or id…"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <div className="voice-list">
        {shown.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`voice-row ${v.id === value ? 'on' : ''}`}
            disabled={disabled}
            onClick={() => onChange(v.id)}
          >
            {v.name}
            {v.note && <span className="tag">{v.note}</span>}
            <span className="id mono">{v.id}</span>
          </button>
        ))}
        {shown.length === 0 && <p className="muted small pad">No voice matches that under this language.</p>}
      </div>

      {matches.length > CAP && (
        <p className="muted small foot">
          Showing {CAP} of {matches.length} — narrow the search, or paste an id into the field below.
        </p>
      )}
    </div>
  );
}
