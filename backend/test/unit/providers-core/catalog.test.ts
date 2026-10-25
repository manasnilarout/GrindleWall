/**
 * Catalog structure, narrowing (provider -> model -> language) and readiness,
 * checked per entry so a failure names the exact provider/model/language.
 *
 * What this does NOT prove: that any vendor accepts what the catalog lists.
 * The generated Murf/Cartesia tables were measured when generated; the rest is
 * doc-derived. These tests pin only internal consistency.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG,
  byKind,
  catalogWithReadiness,
  findProvider,
  languagesFor,
  missingEnvFor,
  voicesFor,
  type ModelEntry,
  type ProviderEntry,
} from '../../../src/providers/catalog.js';
import {
  CARTESIA_LANGUAGE_NAMES,
  CARTESIA_MODEL_LANGUAGES,
  CARTESIA_VOICES_BY_LANGUAGE,
} from '../../../src/providers/cartesia-catalog.js';
import {
  MURF_FALCON_LOCALES,
  MURF_FALCON_VOICES,
  MURF_GEN2_LOCALES,
  MURF_GEN2_VOICES,
} from '../../../src/providers/murf-catalog.js';
import { SARVAM_V4_FLASH_DEFAULT_VOICE, SARVAM_V4_FLASH_LANGUAGES } from '../../../src/providers/sarvam-catalog.js';

const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const KINDS = ['realtime', 'stt', 'llm', 'tts'] as const;
const IMPLEMENTED = CATALOG.filter((p) => p.implemented);

/** Every env var the catalog mentions, aliases included. */
const ALL_ENV = [...new Set(CATALOG.flatMap((p) => [...p.envKeys, ...Object.values(p.envAliases ?? {}).flat()]))];

function blankAllEnv() {
  for (const k of ALL_ENV) vi.stubEnv(k, '');
}

/** Whether a provider exposes voices anywhere in its tree. */
const hasVoices = (p: ProviderEntry) =>
  !!p.voices?.length ||
  !!p.voicesByLanguage ||
  p.models.some((m) => m.voices?.length || m.languages?.some((l) => l.voices?.length));

/** All (provider, model, language|undefined) triples a UI user can click to. */
const TRIPLES = IMPLEMENTED.flatMap((p) =>
  p.models.flatMap((m) => {
    const langs = languagesFor(p.id, m.id);
    return langs.length
      ? langs.map((l) => ({ p, m, lang: l.id as string | undefined, label: `${p.id} / ${m.id} / ${l.id}` }))
      : [{ p, m, lang: undefined as string | undefined, label: `${p.id} / ${m.id} / (no language)` }];
  }),
);

function checkEntry(e: ModelEntry, where: string) {
  expect(typeof e.id, where).toBe('string');
  expect(e.id.trim().length, `${where}: empty id`).toBeGreaterThan(0);
  expect(e.id, `${where}: id has surrounding whitespace`).toBe(e.id.trim());
  expect(typeof e.name, where).toBe('string');
  expect(e.name.trim().length, `${where}: empty name`).toBeGreaterThan(0);
  if (e.note !== undefined) expect(e.note.trim().length, `${where}: empty note`).toBeGreaterThan(0);
}

/* =============================== structure =============================== */

describe('catalog structure', () => {
  it('has 26 providers with unique, non-empty ids', () => {
    expect(CATALOG).toHaveLength(26);
    expect(dupes(ids(CATALOG))).toEqual([]);
    for (const p of CATALOG) expect(p.id.trim()).not.toBe('');
  });

  it('provider ids are kebab-case (they travel as env values and URLs)', () => {
    for (const p of CATALOG) expect(p.id, p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('every kind is represented, with a mock that is implemented and needs no env', () => {
    for (const kind of KINDS) {
      const entries = byKind(kind);
      expect(entries.length, kind).toBeGreaterThan(0);
      const mock = findProvider(`mock-${kind}`);
      expect(mock?.kind).toBe(kind);
      expect(mock?.implemented).toBe(true);
      expect(mock?.envKeys).toEqual([]);
    }
  });

  it('byKind partitions the catalog', () => {
    const all = KINDS.flatMap((k) => byKind(k));
    expect(all).toHaveLength(CATALOG.length);
    for (const k of KINDS) for (const p of byKind(k)) expect(p.kind).toBe(k);
  });

  it('findProvider returns the same object and undefined for unknown ids', () => {
    for (const p of CATALOG) expect(findProvider(p.id)).toBe(p);
    expect(findProvider('nope')).toBeUndefined();
    expect(findProvider('')).toBeUndefined();
    expect(findProvider('MOCK-STT')).toBeUndefined();
  });

  describe.each(CATALOG.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    it('has a name, a valid kind and a boolean implemented flag', () => {
      expect(p.name.trim()).not.toBe('');
      expect(KINDS).toContain(p.kind);
      expect(typeof p.implemented).toBe('boolean');
    });

    it('has at least one model, ids unique and well-formed', () => {
      expect(p.models.length).toBeGreaterThan(0);
      expect(dupes(ids(p.models))).toEqual([]);
      for (const m of p.models) checkEntry(m, `${p.id}:${m.id}`);
    });

    it('envKeys are SCREAMING_SNAKE_CASE env var names, unique', () => {
      expect(Array.isArray(p.envKeys)).toBe(true);
      expect(dupes(p.envKeys)).toEqual([]);
      for (const k of p.envKeys) expect(k).toMatch(/^[A-Z][A-Z0-9_]*$/);
    });

    it('a non-mock provider needs at least one env key', () => {
      if (p.id.startsWith('mock-')) expect(p.envKeys).toEqual([]);
      else expect(p.envKeys.length).toBeGreaterThan(0);
    });

    it('envAliases only alias keys it actually requires', () => {
      for (const [k, aliases] of Object.entries(p.envAliases ?? {})) {
        expect(p.envKeys).toContain(k);
        expect(aliases.length).toBeGreaterThan(0);
        for (const a of aliases) {
          expect(a).toMatch(/^[A-Z][A-Z0-9_]*$/);
          expect(a).not.toBe(k);
        }
      }
    });

    it('provider-level voices and languages are well-formed and unique', () => {
      if (p.voices) {
        expect(p.voices.length).toBeGreaterThan(0);
        expect(dupes(ids(p.voices))).toEqual([]);
        p.voices.forEach((v) => checkEntry(v, `${p.id} voice ${v.id}`));
      }
      if (p.languages) {
        expect(p.languages.length).toBeGreaterThan(0);
        expect(dupes(ids(p.languages))).toEqual([]);
        p.languages.forEach((l) => checkEntry(l, `${p.id} language ${l.id}`));
      }
    });

    it('model-level voices and languages (and language-level voices) are well-formed and unique', () => {
      for (const m of p.models) {
        if (m.voices) {
          expect(m.voices.length, m.id).toBeGreaterThan(0);
          expect(dupes(ids(m.voices)), m.id).toEqual([]);
          m.voices.forEach((v) => checkEntry(v, `${p.id}:${m.id} voice ${v.id}`));
        }
        if (m.languages) {
          expect(m.languages.length, m.id).toBeGreaterThan(0);
          expect(dupes(ids(m.languages)), m.id).toEqual([]);
          for (const l of m.languages) {
            checkEntry(l, `${p.id}:${m.id} language ${l.id}`);
            if (l.voices) {
              expect(l.voices.length, `${m.id}/${l.id}`).toBeGreaterThan(0);
              expect(dupes(ids(l.voices)), `${m.id}/${l.id}`).toEqual([]);
              l.voices.forEach((v) => checkEntry(v, `${p.id}:${m.id}/${l.id} voice ${v.id}`));
            }
          }
        }
      }
    });

    it('acceptsVoiceId comes with a hint, and only on TTS/realtime providers that are implemented', () => {
      if (p.acceptsVoiceId) {
        expect(p.voiceIdHint?.trim()).toBeTruthy();
        expect(['tts', 'realtime']).toContain(p.kind);
        expect(p.implemented).toBe(true);
      } else {
        expect(p.voiceIdHint).toBeUndefined();
      }
    });

    it('docs, where given, is an https URL', () => {
      if (p.docs !== undefined) expect(p.docs).toMatch(/^https:\/\/\S+$/);
    });

    it('voices are only offered by speaking providers (tts / realtime)', () => {
      if (p.kind === 'stt' || p.kind === 'llm') expect(hasVoices(p)).toBe(false);
    });
  });
});

/* ============================= @variant suffix ============================= */

describe('@variant model ids', () => {
  const VARIANTS = CATALOG.flatMap((p) => p.models.filter((m) => m.id.includes('@')).map((m) => [p.id, m] as const));

  it('exist for the reasoning-depth and stream-type providers', () => {
    const providers = new Set(VARIANTS.map(([pid]) => pid));
    expect([...providers].sort()).toEqual(['anthropic-llm', 'google-llm', 'openai-llm', 'sarvam-stt']);
  });

  it.each(VARIANTS.map(([pid, m]) => [`${pid}:${m.id}`, pid, m] as const))('%s splits into base@variant', (_l, pid, m) => {
    const parts = m.id.split('@');
    expect(parts).toHaveLength(2);
    const [base, variant] = parts;
    expect(base.length).toBeGreaterThan(0);
    expect(variant).toMatch(/^[a-z]+$/);
    // The display name encodes the same split, so the UI and the wire agree.
    expect(m.name).toBe(`${base} (${variant})`);
    const allowed: Record<string, string[]> = {
      'anthropic-llm': ['off', 'low', 'medium', 'high'],
      'google-llm': ['off', 'minimal', 'low', 'medium', 'high'],
      'openai-llm': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      'sarvam-stt': ['fast', 'balanced'],
    };
    expect(allowed[pid]).toContain(variant);
  });

  it('google-llm: every listed base is offered with a no-thinking variant (off or minimal)', () => {
    const p = findProvider('google-llm')!;
    const bases = new Set(p.models.map((m) => m.id.split('@')[0]));
    for (const b of bases) {
      const vs = p.models.filter((m) => m.id.startsWith(`${b}@`)).map((m) => m.id.split('@')[1]);
      expect(vs.some((v) => v === 'off' || v === 'minimal' || v === 'low'), b).toBe(true);
    }
  });

  it('openai-llm: un-suffixed models are the ones that take no reasoning parameter', () => {
    const plain = findProvider('openai-llm')!.models.filter((m) => !m.id.includes('@')).map((m) => m.id);
    expect(plain.sort()).toEqual(['gpt-4.1-mini', 'gpt-4o-mini']);
  });

  it('sarvam-stt: every base is offered at both stream types and is in the streaming spec enum', () => {
    const p = findProvider('sarvam-stt')!;
    const bases = new Set(p.models.map((m) => m.id.split('@')[0]));
    expect([...bases].sort()).toEqual(['saaras:v3-realtime', 'saaras:v4']);
    for (const b of bases) {
      expect(p.models.some((m) => m.id === `${b}@fast`)).toBe(true);
      expect(p.models.some((m) => m.id === `${b}@balanced`)).toBe(true);
    }
  });
});

/* =========================== narrowing: per entry =========================== */

describe('every click-through path resolves (provider -> model -> language)', () => {
  const VOICED = IMPLEMENTED.filter(hasVoices);
  const VOICED_TRIPLES = TRIPLES.filter((t) => hasVoices(t.p));

  it('there are voiced implemented providers to check', () => {
    expect(VOICED.map((p) => p.id).sort()).toEqual(
      ['aws-nova-sonic', 'cartesia-tts', 'elevenlabs-tts', 'gemini-tts', 'mock-realtime', 'mock-tts', 'murf-tts', 'openai-realtime', 'sarvam-tts'].sort(),
    );
  });

  it.each(VOICED.map((p) => [p.id, p] as const))('%s: the default selection (no model, no language) has voices', (_id, p) => {
    expect(voicesFor(p.id).length).toBeGreaterThan(0);
    const m = p.models[0].id;
    expect(voicesFor(p.id, m, languagesFor(p.id, m)[0]?.id).length).toBeGreaterThan(0);
  });

  it.each(VOICED_TRIPLES.map((t) => [t.label, t] as const))('%s: has voices, no duplicates', (_l, t) => {
    const vs = voicesFor(t.p.id, t.m.id, t.lang);
    expect(vs.length).toBeGreaterThan(0);
    expect(dupes(ids(vs))).toEqual([]);
    vs.forEach((v) => checkEntry(v, `${t.label} voice ${v.id}`));
  });

  it.each(IMPLEMENTED.flatMap((p) => p.models.map((m) => [`${p.id} / ${m.id}`, p, m] as const)))(
    '%s: languagesFor follows model-over-provider precedence',
    (_l, p, m) => {
      const langs = languagesFor(p.id, m.id);
      if (m.languages) expect(langs).toBe(m.languages);
      else if (p.languages) expect(langs).toBe(p.languages);
      else expect(langs).toEqual([]);
      expect(dupes(ids(langs))).toEqual([]);
    },
  );

  it.each(VOICED_TRIPLES.map((t) => [t.label, t] as const))('%s: voicesFor picks the narrowest list', (_l, t) => {
    const vs = voicesFor(t.p.id, t.m.id, t.lang);
    const lang = t.m.languages?.find((l) => l.id === t.lang);
    if (lang?.voices) expect(vs).toBe(lang.voices);
    else if (lang && t.p.voicesByLanguage?.[lang.id]) expect(vs).toBe(t.p.voicesByLanguage[lang.id]);
    else if (lang || !t.m.languages) {
      // A language with no voices of its own (or no languages at all) falls through to model then provider.
      expect(vs).toBe(t.m.voices ?? t.p.voices);
    }
  });

  it.each(IMPLEMENTED.filter((p) => !hasVoices(p)).map((p) => [p.id, p] as const))(
    '%s (voiceless): voicesFor is empty on every path',
    (_id, p) => {
      for (const m of p.models) {
        expect(voicesFor(p.id, m.id)).toEqual([]);
        for (const l of languagesFor(p.id, m.id)) expect(voicesFor(p.id, m.id, l.id)).toEqual([]);
      }
    },
  );

  it('the not-implemented providers resolve too (the UI renders them disabled, not broken)', () => {
    for (const p of CATALOG.filter((x) => !x.implemented)) {
      for (const m of p.models) {
        expect(() => voicesFor(p.id, m.id)).not.toThrow();
        expect(() => languagesFor(p.id, m.id)).not.toThrow();
        if (p.voices) expect(voicesFor(p.id, m.id)).toBe(p.voices);
      }
    }
  });
});

/* ========================== narrowing: fallbacks ========================== */

describe('voicesFor / languagesFor fallbacks', () => {
  it('unknown provider -> empty lists', () => {
    expect(voicesFor('no-such')).toEqual([]);
    expect(voicesFor('no-such', 'x', 'en')).toEqual([]);
    expect(languagesFor('no-such')).toEqual([]);
    expect(languagesFor('no-such', 'x')).toEqual([]);
  });

  it('no model id -> the first model', () => {
    for (const p of IMPLEMENTED) {
      expect(languagesFor(p.id)).toEqual(languagesFor(p.id, p.models[0].id));
      expect(voicesFor(p.id)).toEqual(voicesFor(p.id, p.models[0].id));
    }
  });

  it('unknown model -> provider-level lists (never another model’s)', () => {
    expect(voicesFor('sarvam-tts', 'bulbul:v99')).toBe(findProvider('sarvam-tts')!.voices);
    expect(languagesFor('sarvam-tts', 'bulbul:v99')).toBe(findProvider('sarvam-tts')!.languages);
    // Murf has no provider-level lists at all: an unknown model gets nothing,
    // rather than one model's voices the other would reject.
    expect(voicesFor('murf-tts', 'gen99')).toEqual([]);
    expect(languagesFor('murf-tts', 'gen99')).toEqual([]);
  });

  it('unknown language -> first language of the model that has voices', () => {
    expect(voicesFor('aws-nova-sonic', 'amazon.nova-2-sonic-v1:0', 'xx-XX').map((v) => v.id)).toEqual(['tiffany', 'matthew']);
    expect(voicesFor('cartesia-tts', 'sonic-3.6', 'xx')).toBe(CARTESIA_VOICES_BY_LANGUAGE.en);
    expect(voicesFor('sarvam-tts', 'bulbul:v4-flash', 'xx-IN')).toBe(SARVAM_V4_FLASH_LANGUAGES[0].voices);
  });

  it('a language the model does not take does not leak through from the shared library', () => {
    // sonic-2 does not take Hindi; asking for it must not hand back the Hindi voices.
    expect(languagesFor('cartesia-tts', 'sonic-2').map((l) => l.id)).not.toContain('hi');
    expect(voicesFor('cartesia-tts', 'sonic-2', 'hi')).not.toBe(CARTESIA_VOICES_BY_LANGUAGE.hi);
    expect(voicesFor('cartesia-tts', 'sonic-2', 'hi')).toBe(CARTESIA_VOICES_BY_LANGUAGE.en);
  });

  it('a language with no voices of its own falls through to the model (Murf locales)', () => {
    for (const l of MURF_FALCON_LOCALES) expect(voicesFor('murf-tts', 'falcon-2', l.id)).toBe(MURF_FALCON_VOICES);
    for (const l of MURF_GEN2_LOCALES) expect(voicesFor('murf-tts', 'gen2', l.id)).toBe(MURF_GEN2_VOICES);
  });

  it('a language with no voices of its own falls through to the provider (Gemini TTS)', () => {
    const p = findProvider('gemini-tts')!;
    for (const m of p.models) for (const l of languagesFor(p.id, m.id)) expect(voicesFor(p.id, m.id, l.id)).toBe(p.voices);
  });

  it('model voices win over provider voices (Sarvam v2)', () => {
    const v2 = findProvider('sarvam-tts')!.models.find((m) => m.id === 'bulbul:v2')!;
    expect(voicesFor('sarvam-tts', 'bulbul:v2')).toBe(v2.voices);
    expect(voicesFor('sarvam-tts', 'bulbul:v2', 'hi-IN')).toBe(v2.voices);
    expect(ids(v2.voices!).sort()).toEqual(['abhilash', 'anushka', 'arya', 'hitesh', 'karun', 'manisha', 'vidya']);
  });

  it('language voices win over model and provider voices (Sarvam v4-flash, Nova)', () => {
    const hi = SARVAM_V4_FLASH_LANGUAGES.find((l) => l.id === 'hi-IN')!;
    expect(voicesFor('sarvam-tts', 'bulbul:v4-flash', 'hi-IN')).toBe(hi.voices);
    const nova = findProvider('aws-nova-sonic')!;
    const fr = nova.models[0].languages!.find((l) => l.id === 'fr-FR')!;
    expect(voicesFor(nova.id, nova.models[0].id, 'fr-FR')).toBe(fr.voices);
    expect(voicesFor(nova.id, nova.models[0].id, 'fr-FR')).not.toBe(nova.voices);
  });

  it('is pure: repeated calls return the same arrays and do not mutate the catalog', () => {
    const before = JSON.stringify(CATALOG);
    for (const t of TRIPLES) {
      expect(voicesFor(t.p.id, t.m.id, t.lang)).toEqual(voicesFor(t.p.id, t.m.id, t.lang));
      expect(languagesFor(t.p.id, t.m.id)).toEqual(languagesFor(t.p.id, t.m.id));
    }
    expect(JSON.stringify(CATALOG)).toBe(before);
  });
});

/* ============================== vendor tables ============================== */

describe('Cartesia generated tables', () => {
  const p = findProvider('cartesia-tts')!;

  it('the provider carries the shared library once, by reference', () => {
    expect(p.voicesByLanguage).toBe(CARTESIA_VOICES_BY_LANGUAGE);
    for (const m of p.models) for (const l of m.languages ?? []) expect(l.voices).toBeUndefined();
  });

  it('934 voices, each filed exactly once, under 44 named languages', () => {
    const all = Object.values(CARTESIA_VOICES_BY_LANGUAGE).flat();
    expect(all).toHaveLength(934);
    expect(dupes(ids(all))).toEqual([]);
    expect(Object.keys(CARTESIA_VOICES_BY_LANGUAGE)).toHaveLength(44);
    expect(Object.keys(CARTESIA_LANGUAGE_NAMES).sort()).toEqual(Object.keys(CARTESIA_VOICES_BY_LANGUAGE).sort());
  });

  it.each(Object.entries(CARTESIA_VOICES_BY_LANGUAGE))('language %s: non-empty, uuid ids, named', (lang, voices) => {
    expect(voices.length).toBeGreaterThan(0);
    expect(CARTESIA_LANGUAGE_NAMES[lang]).toBeTruthy();
    for (const v of voices) {
      expect(v.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      checkEntry(v, `${lang}/${v.id}`);
    }
  });

  it('the model table and the catalog list the same models, in the same order', () => {
    expect(Object.keys(CARTESIA_MODEL_LANGUAGES)).toEqual(ids(p.models));
  });

  it.each(p.models.map((m) => [m.id, m] as const))('%s: language list mirrors the table and every language has voices', (id, m) => {
    const table = CARTESIA_MODEL_LANGUAGES[id];
    expect(ids(m.languages!)).toEqual(table);
    expect(dupes(table)).toEqual([]);
    for (const l of m.languages!) {
      expect(l.name).toBe(CARTESIA_LANGUAGE_NAMES[l.id]);
      expect(CARTESIA_VOICES_BY_LANGUAGE[l.id]?.length, l.id).toBeGreaterThan(0);
    }
    // Every model's set is a subset of the newest model's (which takes all 44).
    for (const l of table) expect(CARTESIA_MODEL_LANGUAGES['sonic-3.6']).toContain(l);
  });

  it('measured language counts: 44 / 42 / 42 / 9 / 8', () => {
    expect(Object.fromEntries(Object.entries(CARTESIA_MODEL_LANGUAGES).map(([k, v]) => [k, v.length]))).toEqual({
      'sonic-3.6': 44,
      'sonic-3.5': 42,
      'sonic-3': 42,
      'sonic-turbo': 9,
      'sonic-2': 8,
    });
    expect(CARTESIA_MODEL_LANGUAGES['sonic-2']).not.toContain('hi');
    expect(CARTESIA_MODEL_LANGUAGES['sonic-3.5']).not.toContain('or');
    expect(CARTESIA_MODEL_LANGUAGES['sonic-3.5']).not.toContain('ur');
  });

  it('Hindi voices are disjoint from English voices', () => {
    const en = new Set(ids(voicesFor('cartesia-tts', 'sonic-3.6', 'en')));
    const hi = voicesFor('cartesia-tts', 'sonic-3.6', 'hi');
    expect(hi.length).toBeGreaterThan(20);
    expect(hi.filter((v) => en.has(v.id))).toEqual([]);
  });
});

describe('Murf generated tables', () => {
  const p = findProvider('murf-tts')!;
  const falcon = p.models.find((m) => m.id === 'falcon-2')!;
  const gen2 = p.models.find((m) => m.id === 'gen2')!;

  it('voices and locales hang off the model, not the provider', () => {
    expect(p.voices).toBeUndefined();
    expect(p.languages).toBeUndefined();
    expect(p.voicesByLanguage).toBeUndefined();
    expect(falcon.voices).toBe(MURF_FALCON_VOICES);
    expect(falcon.languages).toBe(MURF_FALCON_LOCALES);
    expect(gen2.voices).toBe(MURF_GEN2_VOICES);
    expect(gen2.languages).toBe(MURF_GEN2_LOCALES);
  });

  it('Falcon 137 / Gen2 163 voices, 100 shared, no duplicates', () => {
    expect(MURF_FALCON_VOICES).toHaveLength(137);
    expect(MURF_GEN2_VOICES).toHaveLength(163);
    expect(dupes(ids(MURF_FALCON_VOICES))).toEqual([]);
    expect(dupes(ids(MURF_GEN2_VOICES))).toEqual([]);
    const g = new Set(ids(MURF_GEN2_VOICES));
    expect(MURF_FALCON_VOICES.filter((v) => g.has(v.id))).toHaveLength(100);
  });

  it.each([
    ['falcon-2', MURF_FALCON_VOICES, MURF_FALCON_LOCALES],
    ['gen2', MURF_GEN2_VOICES, MURF_GEN2_LOCALES],
  ] as const)('%s: every voice id is <published locale>-<name>', (_m, voices, locales) => {
    const locs = ids(locales);
    expect(dupes(locs)).toEqual([]);
    for (const l of locs) expect(l).toMatch(/^[a-z]{2,3}-[A-Z]{2,5}$/);
    for (const v of voices) {
      // Names are lowercase but not ASCII-only (`de-DE-björn`).
      expect(v.id).toMatch(/^[a-z]{2,3}-[A-Z]{2,5}-\p{Ll}[\p{Ll}-]*$/u);
      // `ko-KR-jong-su`: the name itself may carry a dash, so match on prefix.
      expect(locs.some((l) => v.id.startsWith(`${l}-`)), v.id).toBe(true);
      checkEntry(v, v.id);
    }
  });

  it('the voice-model mismatch the vendor rejects is not reachable through voicesFor', () => {
    const falconOnly = MURF_FALCON_VOICES.filter((v) => !MURF_GEN2_VOICES.some((g) => g.id === v.id));
    expect(falconOnly.length).toBe(37);
    for (const l of MURF_GEN2_LOCALES) {
      const offered = new Set(ids(voicesFor('murf-tts', 'gen2', l.id)));
      for (const v of falconOnly) expect(offered.has(v.id)).toBe(false);
    }
  });

  it('accepts a free-text voice id (cloned / library voices)', () => {
    expect(p.acceptsVoiceId).toBe(true);
  });
});

describe('Sarvam generated table (doc-derived)', () => {
  const langs = SARVAM_V4_FLASH_LANGUAGES;
  const v4 = findProvider('sarvam-tts')!.models.find((m) => m.id === 'bulbul:v4-flash')!;

  it('is wired to the v4-flash model, and only to it', () => {
    expect(v4.languages).toBe(SARVAM_V4_FLASH_LANGUAGES);
    for (const m of findProvider('sarvam-tts')!.models.filter((x) => x !== v4)) expect(m.languages).toBeUndefined();
  });

  it('nine languages, each with personas', () => {
    expect(ids(langs).sort()).toEqual(['bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'mr-IN', 'pa-IN', 'ta-IN', 'te-IN']);
    for (const l of langs) expect(l.voices?.length, l.id).toBeGreaterThan(0);
  });

  it('222 unique personas, all <name>_<lang>_<style>, filed under their own language', () => {
    const all = langs.flatMap((l) => l.voices ?? []);
    const unique = new Set(ids(all));
    expect(unique.size).toBe(222);
    for (const l of langs) {
      for (const v of l.voices!) {
        expect(v.id).toMatch(/^[a-z]+_[a-z]+_[a-z_]+$/);
        const code = v.id.split('_')[1];
        expect(code === 'enhi' || code === l.id.split('-')[0], `${l.id}/${v.id}`).toBe(true);
      }
    }
  });

  it('the only ids filed twice are the 13 enhi personas, under exactly en-IN and hi-IN', () => {
    const where = new Map<string, string[]>();
    for (const l of langs) for (const v of l.voices!) where.set(v.id, [...(where.get(v.id) ?? []), l.id]);
    const twice = [...where].filter(([, ls]) => ls.length > 1);
    expect(twice).toHaveLength(13);
    for (const [id, ls] of twice) {
      expect(id).toContain('_enhi_');
      expect(ls.sort()).toEqual(['en-IN', 'hi-IN']);
    }
    for (const [id, ls] of where) if (id.includes('_enhi_')) expect(ls.sort()).toEqual(['en-IN', 'hi-IN']);
  });

  it('the default persona leads the first language, which is the default selection', () => {
    expect(langs[0].id).toBe('en-IN');
    expect(langs[0].voices![0].id).toBe(SARVAM_V4_FLASH_DEFAULT_VOICE);
    expect(voicesFor('sarvam-tts', 'bulbul:v4-flash')[0].id).toBe(SARVAM_V4_FLASH_DEFAULT_VOICE);
  });

  it('v3 speakers and v4 personas share no ids', () => {
    const v3 = new Set(ids(voicesFor('sarvam-tts', 'bulbul:v3', 'en-IN')));
    expect(v3.size).toBeGreaterThan(0);
    for (const l of langs) for (const v of l.voices!) expect(v3.has(v.id)).toBe(false);
  });
});

/* ================================ readiness ================================ */

describe('missingEnvFor / catalogWithReadiness', () => {
  beforeEach(blankAllEnv);

  it('with every env var blank: only the implemented mocks are ready', () => {
    const ready = catalogWithReadiness().filter((p) => p.ready).map((p) => p.id);
    expect(ready.sort()).toEqual(['mock-llm', 'mock-realtime', 'mock-stt', 'mock-tts']);
  });

  it('returns one row per catalog entry, carrying every field plus readiness, without mutating CATALOG', () => {
    const rows = catalogWithReadiness();
    expect(rows).toHaveLength(CATALOG.length);
    rows.forEach((r, i) => {
      const { missingEnv, ready, ...rest } = r;
      expect(rest).toEqual(CATALOG[i]);
      expect(Array.isArray(missingEnv)).toBe(true);
      expect(typeof ready).toBe('boolean');
      expect('missingEnv' in CATALOG[i]).toBe(false);
      expect('ready' in CATALOG[i]).toBe(false);
    });
  });

  it('is recomputed from the live environment on every call', () => {
    const before = catalogWithReadiness().find((p) => p.id === 'sarvam-stt')!;
    expect(before.ready).toBe(false);
    vi.stubEnv('SARVAM_API_KEY', 'k');
    expect(catalogWithReadiness().find((p) => p.id === 'sarvam-stt')!.ready).toBe(true);
    vi.stubEnv('SARVAM_API_KEY', '');
    expect(catalogWithReadiness().find((p) => p.id === 'sarvam-stt')!.ready).toBe(false);
  });

  describe.each(CATALOG.map((p) => [p.id, p] as const))('%s', (_id, p) => {
    const row = () => catalogWithReadiness().find((r) => r.id === p.id)!;

    it('all keys blank: every key is missing', () => {
      expect(missingEnvFor(p)).toEqual(p.envKeys);
      expect(row().missingEnv).toEqual(p.envKeys);
      expect(row().ready).toBe(p.implemented && p.envKeys.length === 0);
    });

    it('all keys set: nothing missing, ready iff implemented', () => {
      for (const k of p.envKeys) vi.stubEnv(k, 'x');
      expect(missingEnvFor(p)).toEqual([]);
      expect(row().missingEnv).toEqual([]);
      expect(row().ready).toBe(p.implemented);
    });

    it.each(p.envKeys.map((k) => [k] as const))('only %s missing: reported alone, not ready', (k) => {
      for (const other of p.envKeys) vi.stubEnv(other, 'x');
      vi.stubEnv(k, '');
      expect(missingEnvFor(p)).toEqual([k]);
      expect(row().missingEnv).toEqual([k]);
      expect(row().ready).toBe(false);
    });
  });

  it('an empty string is not a key (setup blanks keys that way)', () => {
    vi.stubEnv('CARTESIA_API_KEY', '');
    expect(missingEnvFor(findProvider('cartesia-tts')!)).toEqual(['CARTESIA_API_KEY']);
  });

  it('one key shared by several providers readies all of them at once', () => {
    vi.stubEnv('GOOGLE_API_KEY', 'g');
    const rows = catalogWithReadiness().filter((p) => p.envKeys.includes('GOOGLE_API_KEY'));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect(r.missingEnv).toEqual([]);
      expect(r.ready).toBe(r.implemented && r.envKeys.length === 1);
    }
    // gemini-live is listed but not implemented: env alone never makes it ready.
    expect(rows.find((r) => r.id === 'gemini-live')!.ready).toBe(false);
  });

  describe('envAliases (AWS_DEFAULT_REGION satisfies AWS_REGION)', () => {
    const nova = findProvider('aws-nova-sonic')!;
    beforeEach(() => {
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'a');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 's');
    });

    it('declares the alias', () => {
      expect(nova.envAliases).toEqual({ AWS_REGION: ['AWS_DEFAULT_REGION'] });
    });

    it('neither set -> AWS_REGION is missing (the canonical name is reported, not the alias)', () => {
      expect(missingEnvFor(nova)).toEqual(['AWS_REGION']);
    });

    it('only the alias set -> satisfied, and ready', () => {
      vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
      expect(missingEnvFor(nova)).toEqual([]);
      expect(catalogWithReadiness().find((p) => p.id === nova.id)!.ready).toBe(true);
    });

    it('only the canonical name set -> satisfied', () => {
      vi.stubEnv('AWS_REGION', 'us-east-1');
      expect(missingEnvFor(nova)).toEqual([]);
    });

    it('an alias never stands in for a key it does not alias', () => {
      vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-1');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
      expect(missingEnvFor(nova)).toEqual(['AWS_SECRET_ACCESS_KEY']);
    });
  });
});
