import type {
  LlmProvider,
  RealtimeProvider,
  SessionContext,
  SttProvider,
  TtsProvider,
  VoiceSession,
} from './types.js';
import { PipelineSession } from '../pipeline/PipelineSession.js';
import { findProvider } from './catalog.js';
import { MockRealtimeProvider } from './realtime/MockRealtimeProvider.js';
import { OpenAiRealtimeProvider } from './realtime/OpenAiRealtimeProvider.js';
import { MockSttProvider } from './stt/MockSttProvider.js';
import { SarvamSttProvider } from './stt/SarvamSttProvider.js';
import { CartesiaSttProvider } from './stt/CartesiaSttProvider.js';
import { GeminiSttProvider } from './stt/GeminiSttProvider.js';
import { MockLlmProvider } from './llm/MockLlmProvider.js';
import { GeminiLlmProvider } from './llm/GeminiLlmProvider.js';
import { OpenAiLlmProvider } from './llm/OpenAiLlmProvider.js';
import { MockTtsProvider } from './tts/MockTtsProvider.js';
import { SarvamTtsProvider } from './tts/SarvamTtsProvider.js';
import { CartesiaTtsProvider } from './tts/CartesiaTtsProvider.js';
import { MurfTtsProvider } from './tts/MurfTtsProvider.js';
import { GeminiTtsProvider } from './tts/GeminiTtsProvider.js';
import { ElevenLabsTtsProvider } from './tts/ElevenLabsTtsProvider.js';

/**
 * ============================================================================
 * REGISTRATION POINT
 * ============================================================================
 * Adding a provider is two steps:
 *   1. flip `implemented: true` on its entry in catalog.ts
 *   2. register the class in the matching registry below
 * Nothing else in the app needs to change.
 */

const realtimeRegistry = new Map<string, RealtimeProvider>();
const sttRegistry = new Map<string, SttProvider>();
const llmRegistry = new Map<string, LlmProvider>();
const ttsRegistry = new Map<string, TtsProvider>();

export function registerRealtime(p: RealtimeProvider) { realtimeRegistry.set(p.id, p); }
export function registerStt(p: SttProvider) { sttRegistry.set(p.id, p); }
export function registerLlm(p: LlmProvider) { llmRegistry.set(p.id, p); }
export function registerTts(p: TtsProvider) { ttsRegistry.set(p.id, p); }

registerRealtime(new MockRealtimeProvider());
registerRealtime(new OpenAiRealtimeProvider());
registerStt(new MockSttProvider());
registerStt(new SarvamSttProvider());
registerStt(new CartesiaSttProvider());
registerStt(new GeminiSttProvider());
registerLlm(new MockLlmProvider());
registerLlm(new GeminiLlmProvider());
registerLlm(new OpenAiLlmProvider());
registerTts(new MockTtsProvider());
registerTts(new SarvamTtsProvider());
registerTts(new CartesiaTtsProvider());
registerTts(new MurfTtsProvider());
registerTts(new GeminiTtsProvider());
registerTts(new ElevenLabsTtsProvider());

/** Direct lookups, for scripts that drive one leg in isolation. */
export const getRealtime = (id: string) => realtimeRegistry.get(id);
export const getStt = (id: string) => sttRegistry.get(id);
export const getTts = (id: string) => ttsRegistry.get(id);

export function registeredIds() {
  return {
    realtime: [...realtimeRegistry.keys()],
    stt: [...sttRegistry.keys()],
    llm: [...llmRegistry.keys()],
    tts: [...ttsRegistry.keys()],
  };
}

/* ------------------------------------------------------------------------- */

export class ProviderError extends Error {}

/** Builds whichever session kind the client asked for. The only entry point. */
export function createSession(ctx: SessionContext): VoiceSession {
  const { config } = ctx;

  if (config.mode === 'realtime') {
    const provider = requireFrom(realtimeRegistry, config.realtimeProviderId, 'realtime');
    const model = requireModel(config.realtimeProviderId!, config.realtimeModelId);
    return provider.createSession({ ...ctx, config: { ...config, realtimeModelId: model } });
  }

  const stt = requireFrom(sttRegistry, config.sttProviderId, 'stt');
  const llm = requireFrom(llmRegistry, config.llmProviderId, 'llm');
  const tts = requireFrom(ttsRegistry, config.ttsProviderId, 'tts');

  return new PipelineSession(ctx.sessionId, ctx, {
    stt,
    sttModel: requireModel(config.sttProviderId!, config.sttModelId),
    llm,
    llmModel: requireModel(config.llmProviderId!, config.llmModelId),
    tts,
    ttsModel: requireModel(config.ttsProviderId!, config.ttsModelId),
  });
}

function requireFrom<T>(registry: Map<string, T>, id: string | undefined, kind: string): T {
  if (!id) throw new ProviderError(`No ${kind} provider selected`);
  const entry = findProvider(id);
  if (!entry) throw new ProviderError(`Unknown ${kind} provider: ${id}`);
  const impl = registry.get(id);
  if (!impl) {
    throw new ProviderError(
      `${entry.name} (${id}) is in the catalog but not wired up yet — register it in providers/factory.ts`,
    );
  }
  const missing = entry.envKeys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new ProviderError(`${entry.name} needs ${missing.join(', ')} in the environment`);
  }
  return impl;
}

function requireModel(providerId: string, modelId: string | undefined): string {
  const entry = findProvider(providerId);
  if (!entry) throw new ProviderError(`Unknown provider: ${providerId}`);
  if (!modelId) return entry.models[0].id;
  if (!entry.models.some((m) => m.id === modelId)) {
    throw new ProviderError(`${entry.name} has no model "${modelId}"`);
  }
  return modelId;
}
