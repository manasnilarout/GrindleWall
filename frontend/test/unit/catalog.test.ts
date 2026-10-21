import { describe, expect, it, vi } from 'vitest';
import { fetchCatalog, languagesFor, resolveVoice, voicesFor } from '../../src/lib/catalog';
import type { ProviderEntry } from '../../src/lib/catalog';
import { AUTH_STORAGE_KEY } from '../../src/lib/auth';
import {
  MemoryStorage,
  PROVIDERS,
  cartesiaTts,
  elevenTts,
  m,
  mockRealtime,
  murfTts,
  openaiRealtime,
  provider,
  sarvamStt,
  sarvamTts,
} from './fixtures';

const ids = (list: { id: string }[]) => list.map((v) => v.id);

describe('voicesFor', () => {
  it('is empty for an unknown provider', () => {
    expect(voicesFor(PROVIDERS, 'nope-tts')).toEqual([]);
    expect(voicesFor([], 'sarvam-tts')).toEqual([]);
  });

  it("falls back to the provider's own list when the model has none", () => {
    expect(ids(voicesFor(PROVIDERS, 'sarvam-tts', 'bulbul:v3'))).toEqual(['pooja', 'shubh']);
    expect(ids(voicesFor(PROVIDERS, 'elevenlabs-tts'))).toEqual(['voice-rachel']);
  });

  it("prefers a model's own voices over the provider's (Murf)", () => {
    const withProviderVoices: ProviderEntry = { ...murfTts, voices: [m('provider-level')] };
    expect(ids(voicesFor([withProviderVoices], 'murf-tts', 'falcon-2'))).toEqual(['en-US-falcon-only', 'en-US-shared']);
    expect(ids(voicesFor([withProviderVoices], 'murf-tts', 'gen2'))).toEqual(['en-US-gen2-only', 'en-US-shared']);
  });

  it('uses the first model when the model id is absent or unknown', () => {
    expect(ids(voicesFor(PROVIDERS, 'murf-tts'))).toEqual(['en-US-falcon-only', 'en-US-shared']);
    expect(ids(voicesFor(PROVIDERS, 'murf-tts', 'withdrawn-model'))).toEqual(['en-US-falcon-only', 'en-US-shared']);
  });

  it("narrows by language through the provider's shared library (Cartesia)", () => {
    expect(ids(voicesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6', 'en'))).toEqual(['uuid-en-1', 'uuid-shared']);
    expect(ids(voicesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6', 'hi'))).toEqual(['uuid-hi-1', 'uuid-shared']);
  });

  it('falls back to the first language that has voices for an absent or unknown language', () => {
    expect(ids(voicesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6'))).toEqual(['uuid-en-1', 'uuid-shared']);
    expect(ids(voicesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6', 'xx'))).toEqual(['uuid-en-1', 'uuid-shared']);
    const firstEmpty: ProviderEntry = {
      ...cartesiaTts,
      models: [m('sonic-3.6', { languages: [m('fr'), m('hi')] })],
    };
    expect(ids(voicesFor([firstEmpty], 'cartesia-tts', 'sonic-3.6'))).toEqual(['uuid-hi-1', 'uuid-shared']);
  });

  it('a language that is offered but has no voices falls through to the model, then the provider', () => {
    // `fr` is on sonic-3.6 but has no library entry.
    expect(voicesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6', 'fr')).toEqual([]);
    const withFallback: ProviderEntry = { ...cartesiaTts, voices: [m('generic')] };
    expect(ids(voicesFor([withFallback], 'cartesia-tts', 'sonic-3.6', 'fr'))).toEqual(['generic']);
  });

  it("a language's own voices win over the shared library", () => {
    const own: ProviderEntry = {
      ...cartesiaTts,
      models: [m('sonic-3.6', { languages: [m('en', { voices: [m('inline-en')] })] })],
    };
    expect(ids(voicesFor([own], 'cartesia-tts', 'sonic-3.6', 'en'))).toEqual(['inline-en']);
  });

  it('an explicitly empty language voice list is respected, not widened', () => {
    const empty: ProviderEntry = {
      ...cartesiaTts,
      models: [m('sonic-3.6', { languages: [m('en', { voices: [] })] })],
    };
    expect(voicesFor([empty], 'cartesia-tts', 'sonic-3.6', 'en')).toEqual([]);
  });

  it('ignores the language when the model lists no languages (provider-level languages do not narrow)', () => {
    expect(ids(voicesFor(PROVIDERS, 'sarvam-tts', 'bulbul:v3', 'od-IN'))).toEqual(['pooja', 'shubh']);
    expect(ids(voicesFor(PROVIDERS, 'openai-realtime', 'gpt-realtime', 'hi'))).toEqual(['marin', 'cedar']);
  });

  it('is empty for a provider with no voices anywhere', () => {
    expect(voicesFor(PROVIDERS, 'sarvam-stt', 'saaras:v3-realtime@fast', 'hi-IN')).toEqual([]);
  });

  it('copes with a provider that has no models', () => {
    const bare = provider('bare-tts', 'tts', { models: [], voices: [m('only')] });
    expect(ids(voicesFor([bare], 'bare-tts', 'x', 'en'))).toEqual(['only']);
  });
});

describe('resolveVoice', () => {
  it('keeps the current voice when the new list still offers it', () => {
    expect(resolveVoice(PROVIDERS, 'cartesia-tts', 'sonic-3.6', 'hi', 'uuid-shared')).toBe('uuid-shared');
    expect(resolveVoice(PROVIDERS, 'murf-tts', 'gen2', 'en-US', 'en-US-shared')).toBe('en-US-shared');
  });

  it('falls back to the head of the list otherwise', () => {
    expect(resolveVoice(PROVIDERS, 'cartesia-tts', 'sonic-3.6', 'hi', 'uuid-en-1')).toBe('uuid-hi-1');
    expect(resolveVoice(PROVIDERS, 'murf-tts', 'gen2', 'en-US', 'en-US-falcon-only')).toBe('en-US-gen2-only');
    expect(resolveVoice(PROVIDERS, 'sarvam-tts', 'bulbul:v3', 'hi-IN', '')).toBe('pooja');
  });

  it("never hands one vendor another's voice id", () => {
    expect(resolveVoice(PROVIDERS, 'openai-realtime', 'gpt-realtime', 'en', 'uuid-en-1')).toBe('marin');
    expect(resolveVoice(PROVIDERS, 'elevenlabs-tts', 'eleven_flash_v2_5', '', 'marin')).toBe('voice-rachel');
  });

  it('is empty when there are no voices to choose from', () => {
    expect(resolveVoice(PROVIDERS, 'sarvam-stt', 'saaras:v4@fast', 'hi-IN', 'pooja')).toBe('');
    expect(resolveVoice(PROVIDERS, 'unknown', '', '', 'pooja')).toBe('');
  });
});

describe('languagesFor', () => {
  it('is empty for an unknown provider', () => {
    expect(languagesFor(PROVIDERS, 'nope')).toEqual([]);
  });

  it("prefers the model's languages (Cartesia narrows per model)", () => {
    expect(ids(languagesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6'))).toEqual(['en', 'hi', 'fr']);
    expect(ids(languagesFor(PROVIDERS, 'cartesia-tts', 'sonic-2'))).toEqual(['en']);
  });

  it("falls back to the provider's languages", () => {
    expect(ids(languagesFor(PROVIDERS, 'sarvam-stt', 'saaras:v4@fast'))).toEqual(['unknown', 'hi-IN', 'or-IN', 'en-IN']);
    expect(ids(languagesFor([sarvamTts], 'sarvam-tts'))).toEqual(['hi-IN', 'od-IN', 'en-IN']);
  });

  it('uses the first model for an absent or unknown model id', () => {
    expect(ids(languagesFor(PROVIDERS, 'cartesia-tts'))).toEqual(['en', 'hi', 'fr']);
    expect(ids(languagesFor(PROVIDERS, 'cartesia-tts', 'sonic-1'))).toEqual(['en', 'hi', 'fr']);
  });

  it('is empty when nothing declares languages', () => {
    expect(languagesFor([elevenTts, mockRealtime], 'elevenlabs-tts')).toEqual([]);
    expect(languagesFor([provider('bare', 'stt', { models: [] })], 'bare')).toEqual([]);
  });

  it('agrees with what voicesFor narrows on', () => {
    for (const lang of languagesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6')) {
      const voices = voicesFor(PROVIDERS, 'cartesia-tts', 'sonic-3.6', lang.id);
      expect(voices).toEqual(cartesiaTts.voicesByLanguage?.[lang.id] ?? []);
    }
    expect(ids(languagesFor([openaiRealtime, sarvamStt], 'openai-realtime'))).toEqual(['en', 'hi']);
  });
});

describe('fetchCatalog', () => {
  const body = { sampleRate: 24000, providers: [sarvamTts] };

  it('returns the parsed catalog', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCatalog()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('/api/catalog');
  });

  it('throws with the status on a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    await expect(fetchCatalog()).rejects.toThrow('Catalog request failed: 503');
  });

  it('sends the stored session token', async () => {
    const storage = new MemoryStorage();
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'tok', username: 'u', expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal('localStorage', storage);
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(body)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchCatalog();
    const init = fetchMock.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
  });

  it('a 401 both kicks the session out and fails the catalog request', async () => {
    const storage = new MemoryStorage();
    storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'tok', username: 'u', expiresAt: Date.now() + 60_000 }));
    vi.stubGlobal('localStorage', storage);
    const win = new EventTarget();
    const expired = vi.fn();
    win.addEventListener('auth:expired', expired);
    vi.stubGlobal('window', win);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await expect(fetchCatalog()).rejects.toThrow('Catalog request failed: 401');
    expect(expired).toHaveBeenCalledTimes(1);
    expect(storage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});
