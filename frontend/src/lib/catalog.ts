import { authFetch } from './auth';

export type ProviderKind = 'realtime' | 'stt' | 'llm' | 'tts';

export interface ModelEntry {
  id: string;
  name: string;
  note?: string;
  /** Voices this model in particular exposes; a model's list wins over the provider's. */
  voices?: ModelEntry[];
  /** Languages this model in particular accepts; same precedence. */
  languages?: ModelEntry[];
}

export interface ProviderEntry {
  id: string;
  name: string;
  kind: ProviderKind;
  implemented: boolean;
  registered: boolean;
  ready: boolean;
  envKeys: string[];
  missingEnv: string[];
  models: ModelEntry[];
  voices?: ModelEntry[];
  /** The vendor takes any voice id, so the picker offers a free-text field too. */
  acceptsVoiceId?: boolean;
  voiceIdHint?: string;
  /** Voices grouped by language, shared across the provider's models. */
  voicesByLanguage?: Record<string, ModelEntry[]>;
  languages?: ModelEntry[];
  docs?: string;
}

export interface CatalogResponse {
  sampleRate: number;
  providers: ProviderEntry[];
}

/**
 * Narrowest list wins: the selected language's own voices, else the model's, else
 * the provider's. Both narrowings are vendor behaviour — Murf rejects a voice
 * belonging to its other model, and Cartesia files 934 voices under 44 languages.
 * Mirrors `voicesFor` / `languagesFor` in the backend catalog.
 */
export function voicesFor(
  providers: ProviderEntry[],
  providerId: string,
  modelId?: string,
  languageId?: string,
): ModelEntry[] {
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return [];
  const model = provider.models.find((m) => m.id === modelId) ?? provider.models[0];
  const byLanguage = provider.voicesByLanguage;
  const language =
    model?.languages?.find((l) => l.id === languageId) ??
    model?.languages?.find((l) => l.voices?.length || byLanguage?.[l.id]?.length);
  return (
    language?.voices ??
    (language ? byLanguage?.[language.id] : undefined) ??
    model?.voices ??
    provider.voices ??
    []
  );
}

/**
 * The voice to hold after a change of provider, model, language or architecture.
 *
 * Keeps the current one when the new list still offers it — an id stays valid
 * across a language change, which is why Cartesia's 934-voice library is
 * navigable at all — and otherwise falls back to the head of the list.
 *
 * Exported rather than inlined in the picker because it is the rule that stops
 * one vendor being handed another's voice id, and a rule that cannot be called
 * from a test is a rule nothing checks. The architecture toggle used to skip it
 * and sent Cartesia UUIDs to OpenAI Realtime and `marin` to ElevenLabs.
 */
export function resolveVoice(
  providers: ProviderEntry[],
  providerId: string,
  modelId: string,
  languageId: string,
  currentVoice: string,
): string {
  const voices = voicesFor(providers, providerId, modelId, languageId);
  if (voices.length === 0) return '';
  return voices.some((v) => v.id === currentVoice) ? currentVoice : voices[0].id;
}

export function languagesFor(
  providers: ProviderEntry[],
  providerId: string,
  modelId?: string,
): ModelEntry[] {
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return [];
  const model = provider.models.find((m) => m.id === modelId) ?? provider.models[0];
  return model?.languages ?? provider.languages ?? [];
}

export async function fetchCatalog(): Promise<CatalogResponse> {
  const res = await authFetch('/api/catalog');
  if (!res.ok) throw new Error(`Catalog request failed: ${res.status}`);
  return res.json();
}
