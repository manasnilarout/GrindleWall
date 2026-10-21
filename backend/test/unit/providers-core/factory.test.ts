/**
 * factory.ts: the registration point and the only session entry point. It must
 * reject an unknown provider, an unknown model and a missing env key BEFORE any
 * provider is constructed, and must agree with the catalog about what exists.
 *
 * No session is started here, so no provider opens a socket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderError,
  createSession,
  getRealtime,
  getStt,
  getTts,
  registeredIds,
} from '../../../src/providers/factory.js';
import { CATALOG, findProvider, type ProviderEntry } from '../../../src/providers/catalog.js';
import { PipelineSession } from '../../../src/pipeline/PipelineSession.js';
import type { StartConfig } from '../../../src/shared/protocol.js';
import type { SessionContext } from '../../../src/providers/types.js';
import { Recorder } from './helpers.js';

const ALL_ENV = [...new Set(CATALOG.flatMap((p) => [...p.envKeys, ...Object.values(p.envAliases ?? {}).flat()]))];
const IMPLEMENTED = CATALOG.filter((p) => p.implemented);

const MOCKS = {
  sttProviderId: 'mock-stt',
  llmProviderId: 'mock-llm',
  ttsProviderId: 'mock-tts',
} as const;

function ctx(config: Partial<StartConfig>): SessionContext {
  return {
    sessionId: 's1',
    config: { mode: 'pipeline', systemPrompt: '', turnDetection: 'server_vad', ...config } as StartConfig,
    events: new Recorder(),
    credentials: {},
  };
}

/** A config that puts `p` in its own slot and mocks everywhere else. */
function configFor(p: ProviderEntry, modelId?: string): Partial<StartConfig> {
  if (p.kind === 'realtime') return { mode: 'realtime', realtimeProviderId: p.id, realtimeModelId: modelId };
  return { mode: 'pipeline', ...MOCKS, [`${p.kind}ProviderId`]: p.id, [`${p.kind}ModelId`]: modelId };
}

const setEnvFor = (p: ProviderEntry) => p.envKeys.forEach((k) => vi.stubEnv(k, `test-${k.toLowerCase()}`));

beforeEach(() => {
  for (const k of ALL_ENV) vi.stubEnv(k, '');
});

/* ============================== registration ============================== */

describe('registry agrees with the catalog', () => {
  it('registers exactly the implemented catalog entries, each under its own kind', () => {
    const reg = registeredIds();
    for (const kind of ['realtime', 'stt', 'llm', 'tts'] as const) {
      const expected = IMPLEMENTED.filter((p) => p.kind === kind).map((p) => p.id).sort();
      expect([...reg[kind]].sort(), kind).toEqual(expected);
    }
  });

  it.each(IMPLEMENTED.map((p) => [p.id, p] as const))('%s (implemented) is registered with a matching id', (id, p) => {
    expect(registeredIds()[p.kind]).toContain(id);
    const impl = p.kind === 'realtime' ? getRealtime(id) : p.kind === 'stt' ? getStt(id) : p.kind === 'tts' ? getTts(id) : undefined;
    if (p.kind !== 'llm') {
      expect(impl, id).toBeDefined();
      expect(impl!.id).toBe(id);
      expect(impl!.name.trim()).not.toBe('');
    }
  });

  it.each(CATALOG.filter((p) => !p.implemented).map((p) => [p.id, p] as const))(
    '%s (not implemented) is registered nowhere and is refused as "not wired up"',
    (id, p) => {
      const reg = registeredIds();
      for (const ids of Object.values(reg)) expect(ids).not.toContain(id);
      setEnvFor(p);
      expect(() => createSession(ctx(configFor(p)))).toThrow(ProviderError);
      expect(() => createSession(ctx(configFor(p)))).toThrow(/not wired up yet/);
    },
  );

  it('no registered id is missing from the catalog or filed under the wrong kind', () => {
    const reg = registeredIds();
    for (const [kind, ids] of Object.entries(reg)) {
      for (const id of ids) {
        expect(findProvider(id)?.kind, id).toBe(kind);
        expect(findProvider(id)?.implemented, id).toBe(true);
      }
    }
  });

  it('direct lookups return undefined for unknown ids', () => {
    expect(getRealtime('nope')).toBeUndefined();
    expect(getStt('nope')).toBeUndefined();
    expect(getTts('nope')).toBeUndefined();
  });

  it('registeredIds hands back copies, not the live registries', () => {
    const a = registeredIds();
    a.stt.push('injected');
    expect(registeredIds().stt).not.toContain('injected');
  });
});

/* ============================ successful creation ============================ */

describe('createSession: success', () => {
  it('pipeline of mocks needs no env and resolves default models from the catalog', () => {
    const s = createSession(ctx({ ...MOCKS }));
    expect(s).toBeInstanceOf(PipelineSession);
    expect(s.mode).toBe('pipeline');
    expect(s.id).toBe('s1');
    expect(s.label).toBe('mock-stt:mock-asr → mock-llm:mock-chat → mock-tts:mock-voice');
  });

  it('pipeline with explicit model ids keeps them', () => {
    const s = createSession(ctx({ ...MOCKS, sttModelId: 'mock-asr', llmModelId: 'mock-chat', ttsModelId: 'mock-voice' }));
    expect(s.label).toBe('mock-stt:mock-asr → mock-llm:mock-chat → mock-tts:mock-voice');
  });

  it('an empty model id is treated as "not chosen" and resolves to the first model', () => {
    const s = createSession(ctx({ ...MOCKS, llmModelId: '' }));
    expect(s.label).toContain('mock-llm:mock-chat');
  });

  it('realtime mock needs no env and receives the resolved model id', () => {
    const c = ctx({ mode: 'realtime', realtimeProviderId: 'mock-realtime' });
    const spy = vi.spyOn(getRealtime('mock-realtime')!, 'createSession');
    const s = createSession(c);
    expect(s.mode).toBe('realtime');
    expect(s.id).toBe('s1');
    expect(spy).toHaveBeenCalledTimes(1);
    const passed = spy.mock.calls[0][0];
    expect(passed.config.realtimeModelId).toBe('mock-s2s');
    // The caller's config object is not mutated; the provider gets a copy.
    expect(c.config.realtimeModelId).toBeUndefined();
    expect(passed.events).toBe(c.events);
    expect(passed.credentials).toBe(c.credentials);
    expect(passed.sessionId).toBe('s1');
  });

  it('realtime mode ignores pipeline slots entirely', () => {
    const s = createSession(ctx({ mode: 'realtime', realtimeProviderId: 'mock-realtime', sttProviderId: 'nope', ttsProviderId: 'nope' }));
    expect(s.mode).toBe('realtime');
  });

  it('pipeline mode ignores the realtime slot entirely', () => {
    const s = createSession(ctx({ ...MOCKS, realtimeProviderId: 'nope' }));
    expect(s.mode).toBe('pipeline');
  });

  it.each(IMPLEMENTED.flatMap((p) => p.models.map((m) => [`${p.id} / ${m.id}`, p, m.id] as const)))(
    '%s constructs once its env is present (no network: not started)',
    (_l, p, modelId) => {
      setEnvFor(p);
      const s = createSession(ctx(configFor(p, modelId)));
      expect(s.mode).toBe(p.kind === 'realtime' ? 'realtime' : 'pipeline');
      if (p.kind !== 'realtime') expect(s.label).toContain(`${p.id}:${modelId}`);
    },
  );

  it('aws-nova-sonic accepts AWS_DEFAULT_REGION in place of AWS_REGION', () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'a');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 's');
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
    expect(() => createSession(ctx({ mode: 'realtime', realtimeProviderId: 'aws-nova-sonic' }))).not.toThrow();
  });
});

/* ================================ rejections ================================ */

describe('createSession: rejections', () => {
  it.each([
    ['realtime', { mode: 'realtime' }, /No realtime provider selected/],
    ['stt', { mode: 'pipeline', llmProviderId: 'mock-llm', ttsProviderId: 'mock-tts' }, /No stt provider selected/],
    ['llm', { mode: 'pipeline', sttProviderId: 'mock-stt', ttsProviderId: 'mock-tts' }, /No llm provider selected/],
    ['tts', { mode: 'pipeline', sttProviderId: 'mock-stt', llmProviderId: 'mock-llm' }, /No tts provider selected/],
  ] as const)('no %s provider selected', (_k, config, msg) => {
    expect(() => createSession(ctx(config as Partial<StartConfig>))).toThrow(ProviderError);
    expect(() => createSession(ctx(config as Partial<StartConfig>))).toThrow(msg);
  });

  it.each([
    ['realtime', { mode: 'realtime', realtimeProviderId: 'bogus-rt' }, /Unknown realtime provider: bogus-rt/],
    ['stt', { ...MOCKS, sttProviderId: 'bogus-stt' }, /Unknown stt provider: bogus-stt/],
    ['llm', { ...MOCKS, llmProviderId: 'bogus-llm' }, /Unknown llm provider: bogus-llm/],
    ['tts', { ...MOCKS, ttsProviderId: 'bogus-tts' }, /Unknown tts provider: bogus-tts/],
  ] as const)('unknown %s provider', (_k, config, msg) => {
    expect(() => createSession(ctx(config as Partial<StartConfig>))).toThrow(ProviderError);
    expect(() => createSession(ctx(config as Partial<StartConfig>))).toThrow(msg);
  });

  it.each([
    ['realtime', { mode: 'realtime', realtimeProviderId: 'mock-realtime', realtimeModelId: 'gpt-9' }, /Mock \(echo\) has no model "gpt-9"/],
    ['stt', { ...MOCKS, sttModelId: 'nope' }, /Mock \(canned\) has no model "nope"/],
    ['llm', { ...MOCKS, llmModelId: 'nope' }, /Mock \(echo\) has no model "nope"/],
    ['tts', { ...MOCKS, ttsModelId: 'nope' }, /Mock \(tone\) has no model "nope"/],
  ] as const)('unknown %s model', (_k, config, msg) => {
    expect(() => createSession(ctx(config as Partial<StartConfig>))).toThrow(ProviderError);
    expect(() => createSession(ctx(config as Partial<StartConfig>))).toThrow(msg);
  });

  it('a model id from a different provider of the same kind is refused', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'g');
    expect(() => createSession(ctx({ ...MOCKS, llmProviderId: 'google-llm', llmModelId: 'gpt-4o-mini' }))).toThrow(/has no model "gpt-4o-mini"/);
  });

  it('a @variant the catalog does not list is refused (support is per model, not assumed)', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'g');
    // gemini-3.7-flash always thinks; @minimal is not a listed pairing.
    expect(() => createSession(ctx({ ...MOCKS, llmProviderId: 'google-llm', llmModelId: 'gemini-3.7-flash@minimal' }))).toThrow(
      /has no model/,
    );
    // The bare base without a variant is not a listed id either.
    expect(() => createSession(ctx({ ...MOCKS, llmProviderId: 'google-llm', llmModelId: 'gemini-3.5-flash' }))).toThrow(/has no model/);
  });

  it('a provider of the wrong kind in a slot is refused', () => {
    expect(() => createSession(ctx({ ...MOCKS, sttProviderId: 'mock-tts' }))).toThrow(ProviderError);
    expect(() => createSession(ctx({ mode: 'realtime', realtimeProviderId: 'mock-stt' }))).toThrow(ProviderError);
    expect(() => createSession(ctx({ ...MOCKS, ttsProviderId: 'mock-realtime' }))).toThrow(ProviderError);
  });

  describe.each(IMPLEMENTED.filter((p) => p.envKeys.length).map((p) => [p.id, p] as const))('%s: env keys', (_id, p) => {
    it('all missing: refused, naming every key', () => {
      const fn = () => createSession(ctx(configFor(p)));
      expect(fn).toThrow(ProviderError);
      expect(fn).toThrow(`${p.name} needs ${p.envKeys.join(', ')} in the environment`);
    });

    it.each(p.envKeys.map((k) => [k] as const))('only %s missing: refused, naming just that key', (k) => {
      setEnvFor(p);
      vi.stubEnv(k, '');
      expect(() => createSession(ctx(configFor(p)))).toThrow(`${p.name} needs ${k} in the environment`);
    });
  });

  it('env is checked before the model, so a keyless user is told about the key first', () => {
    expect(() => createSession(ctx({ ...MOCKS, ttsProviderId: 'cartesia-tts', ttsModelId: 'nope' }))).toThrow(/needs CARTESIA_API_KEY/);
  });

  it('every provider slot is validated before any model (stt, then llm, then tts)', () => {
    expect(() => createSession(ctx({ ...MOCKS, sttProviderId: 'x', ttsProviderId: 'y' }))).toThrow(/Unknown stt provider: x/);
    expect(() => createSession(ctx({ ...MOCKS, sttModelId: 'bad', ttsProviderId: 'y' }))).toThrow(/Unknown tts provider: y/);
  });

  it('credentials in ctx do not substitute for the environment (readiness is process-level)', () => {
    const c = ctx({ ...MOCKS, ttsProviderId: 'cartesia-tts' });
    c.credentials = { CARTESIA_API_KEY: 'from-ctx' };
    expect(() => createSession(c)).toThrow(/needs CARTESIA_API_KEY/);
  });

  it('a rejection constructs nothing', () => {
    const spy = vi.spyOn(getRealtime('mock-realtime')!, 'createSession');
    expect(() => createSession(ctx({ mode: 'realtime', realtimeProviderId: 'mock-realtime', realtimeModelId: 'nope' }))).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('ProviderError is an Error', () => {
    try {
      createSession(ctx({ mode: 'realtime' }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect(e).toBeInstanceOf(Error);
    }
  });
});
