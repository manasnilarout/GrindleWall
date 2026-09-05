import type { ProviderEntry, ProviderKind } from '../lib/catalog';
import type { SessionMode } from '../lib/protocol';
import { Select } from './Select';

export interface Selection {
  mode: SessionMode;
  realtimeProviderId: string;
  realtimeModelId: string;
  sttProviderId: string;
  sttModelId: string;
  llmProviderId: string;
  llmModelId: string;
  ttsProviderId: string;
  ttsModelId: string;
  voice: string;
  language: string;
  sttLanguage: string;
  ttsLanguage: string;
}

interface Props {
  providers: ProviderEntry[];
  value: Selection;
  onChange: (next: Selection) => void;
  disabled: boolean;
}

export function ProviderPicker({ providers, value, onChange, disabled }: Props) {
  const byKind = (kind: ProviderKind) => providers.filter((p) => p.kind === kind);

  const providerOptions = (kind: ProviderKind) =>
    byKind(kind).map((p) => ({
      id: p.id,
      name: p.name,
      disabled: !p.registered,
      hint: !p.registered ? 'not wired up' : p.missingEnv.length ? `needs ${p.missingEnv.join(', ')}` : undefined,
    }));

  const find = (id: string) => providers.find((p) => p.id === id);

  const modelOptions = (providerId: string) =>
    (find(providerId)?.models ?? []).map((m) => ({ id: m.id, name: m.name, hint: m.note }));

  /** Voices come from the realtime provider, or from the TTS provider in pipeline mode. */
  const voiceSource = value.mode === 'realtime' ? find(value.realtimeProviderId) : find(value.ttsProviderId);

  const languageOptions = (providerId: string) =>
    (find(providerId)?.languages ?? []).map((l) => ({ id: l.id, name: l.name }));

  const setProvider = (kind: ProviderKind, id: string) => {
    const entry = find(id);
    const firstModel = entry?.models[0]?.id ?? '';
    const firstVoice = entry?.voices?.[0]?.id ?? '';
    // Providers declare their own language sets, so reset to a valid one on switch.
    const firstLang = entry?.languages?.[0]?.id ?? '';
    if (kind === 'realtime') {
      onChange({ ...value, realtimeProviderId: id, realtimeModelId: firstModel, voice: firstVoice, language: firstLang });
    } else if (kind === 'stt') {
      onChange({ ...value, sttProviderId: id, sttModelId: firstModel, sttLanguage: firstLang });
    } else if (kind === 'llm') {
      onChange({ ...value, llmProviderId: id, llmModelId: firstModel });
    } else {
      onChange({ ...value, ttsProviderId: id, ttsModelId: firstModel, voice: firstVoice, ttsLanguage: firstLang });
    }
  };

  return (
    <section className="panel">
      <h2>Providers</h2>

      <div className="mode-toggle" role="radiogroup" aria-label="Architecture">
        {(['realtime', 'pipeline'] as SessionMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={value.mode === m}
            className={value.mode === m ? 'active' : ''}
            disabled={disabled}
            onClick={() => onChange({ ...value, mode: m })}
          >
            {m === 'realtime' ? 'Realtime (speech-to-speech)' : 'Pipeline (STT → LLM → TTS)'}
          </button>
        ))}
      </div>

      {value.mode === 'realtime' ? (
        <div className="grid">
          <Select
            label="Provider"
            value={value.realtimeProviderId}
            options={providerOptions('realtime')}
            onChange={(id) => setProvider('realtime', id)}
            disabled={disabled}
          />
          <Select
            label="Model"
            value={value.realtimeModelId}
            options={modelOptions(value.realtimeProviderId)}
            onChange={(id) => onChange({ ...value, realtimeModelId: id })}
            disabled={disabled}
          />
          {languageOptions(value.realtimeProviderId).length > 0 && (
            <Select
              label="Language"
              value={value.language}
              options={languageOptions(value.realtimeProviderId)}
              onChange={(id) => onChange({ ...value, language: id })}
              disabled={disabled}
            />
          )}
        </div>
      ) : (
        <div className="grid">
          <Select
            label="STT"
            value={value.sttProviderId}
            options={providerOptions('stt')}
            onChange={(id) => setProvider('stt', id)}
            disabled={disabled}
          />
          <Select
            label="STT model"
            value={value.sttModelId}
            options={modelOptions(value.sttProviderId)}
            onChange={(id) => onChange({ ...value, sttModelId: id })}
            disabled={disabled}
          />
          {languageOptions(value.sttProviderId).length > 0 && (
            <Select
              label="STT language"
              value={value.sttLanguage}
              options={languageOptions(value.sttProviderId)}
              onChange={(id) => onChange({ ...value, sttLanguage: id })}
              disabled={disabled}
            />
          )}
          <Select
            label="LLM"
            value={value.llmProviderId}
            options={providerOptions('llm')}
            onChange={(id) => setProvider('llm', id)}
            disabled={disabled}
          />
          <Select
            label="LLM model"
            value={value.llmModelId}
            options={modelOptions(value.llmProviderId)}
            onChange={(id) => onChange({ ...value, llmModelId: id })}
            disabled={disabled}
          />
          <Select
            label="TTS"
            value={value.ttsProviderId}
            options={providerOptions('tts')}
            onChange={(id) => setProvider('tts', id)}
            disabled={disabled}
          />
          <Select
            label="TTS model"
            value={value.ttsModelId}
            options={modelOptions(value.ttsProviderId)}
            onChange={(id) => onChange({ ...value, ttsModelId: id })}
            disabled={disabled}
          />
          {languageOptions(value.ttsProviderId).length > 0 && (
            <Select
              label="TTS language"
              value={value.ttsLanguage}
              options={languageOptions(value.ttsProviderId)}
              onChange={(id) => onChange({ ...value, ttsLanguage: id })}
              disabled={disabled}
            />
          )}
        </div>
      )}

      {voiceSource?.voices?.length ? (
        <div className="grid">
          <Select
            label="Voice"
            value={value.voice}
            options={voiceSource.voices.map((v) => ({ id: v.id, name: v.name }))}
            onChange={(id) => onChange({ ...value, voice: id })}
            disabled={disabled}
          />
        </div>
      ) : null}
    </section>
  );
}
