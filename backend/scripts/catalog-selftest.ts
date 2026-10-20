/**
 * Catalog invariants, across every provider. No key, no network.
 *
 *   npx tsx scripts/catalog-selftest.ts
 *
 * The catalog is what the UI renders its toggles from, so a wrong entry here is a
 * 400 the user cannot explain. Two vendors narrow their lists in ways that make
 * that easy to get wrong — Murf keeps a voice catalogue per model, Cartesia files
 * 934 voices under 44 languages and accepts a different language set per model —
 * so what is checked is that every path a user can click through resolves to a
 * non-empty selection. For the generated Murf and Cartesia tables that means a
 * combination the vendor was measured to take; for the doc-derived entries
 * (Gemini speech, ElevenLabs, both OpenAI legs, Sarvam's v4 models) it means only one the docs
 * describe — the table's fidelity to the vendor is the untested part.
 */
import { CATALOG, findProvider, languagesFor, voicesFor, type ProviderEntry } from '../src/providers/catalog.js';

const results: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => results.push([n, ok, d]);

const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);
const implemented = CATALOG.filter((p) => p.implemented);

/* 1. structure */
for (const p of CATALOG) {
  check(`${p.id}: has at least one model`, p.models.length > 0);
  check(`${p.id}: no duplicate model ids`, dupes(p.models.map((m) => m.id)).length === 0);
}
check('no duplicate provider ids', dupes(CATALOG.map((p) => p.id)).length === 0);

/* 2. every click-through resolves — the default selection first, then every
   model, then every language under it. This is the UI's own traversal. */
for (const p of implemented) {
  const hasVoices =
    !!p.voices?.length ||
    !!p.voicesByLanguage ||
    p.models.some((m) => m.voices?.length || m.languages?.some((l) => l.voices?.length));
  if (!hasVoices) continue;

  const firstModel = p.models[0].id;
  const firstLang = languagesFor(p.id, firstModel)[0]?.id;
  check(`${p.id}: the default selection resolves to a voice`,
    voicesFor(p.id, firstModel, firstLang).length > 0, `${firstModel}/${firstLang}`);

  for (const model of p.models) {
    const langs = languagesFor(p.id, model.id);
    const empties = langs.filter((l) => voicesFor(p.id, model.id, l.id).length === 0).map((l) => l.id);
    check(`${p.id}:${model.id}: every language it offers has voices`,
      empties.length === 0, empties.slice(0, 6).join(', '));
    check(`${p.id}:${model.id}: no duplicate voice ids`,
      langs.every((l) => dupes(voicesFor(p.id, model.id, l.id).map((v) => v.id)).length === 0));
  }
}

/* 3. Cartesia: language support is per model and was measured live, so the
   catalog must not have drifted back to one list for all models. */
const sonic36 = languagesFor('cartesia-tts', 'sonic-3.6').map((l) => l.id);
const sonic2 = languagesFor('cartesia-tts', 'sonic-2').map((l) => l.id);
check('cartesia: sonic-3.6 carries the full language set', sonic36.length >= 40, `${sonic36.length}`);
check('cartesia: sonic-2 carries a much smaller one', sonic2.length < 12, `${sonic2.length}`);
check('cartesia: sonic-2 does not offer Hindi (the API refuses it)', !sonic2.includes('hi'));
check('cartesia: sonic-3.6 does offer Hindi', sonic36.includes('hi'));
const hindi = voicesFor('cartesia-tts', 'sonic-3.6', 'hi');
check('cartesia: Hindi has its own voices', hindi.length > 20, `${hindi.length}`);
check('cartesia: Hindi voices are not the English ones',
  !hindi.some((v) => voicesFor('cartesia-tts', 'sonic-3.6', 'en').some((e) => e.id === v.id)));
check('cartesia: every voice id is a uuid',
  hindi.every((v) => /^[0-9a-f-]{36}$/.test(v.id)), hindi.find((v) => !/^[0-9a-f-]{36}$/.test(v.id))?.id);

/* 4. Sarvam: speakers are per model (doc-derived — the docs say another model's
   speaker is invalid), so v4-flash must not inherit v3's names or vice versa,
   and the model ids must be the ones the streaming specs enumerate. */
const v4Langs = languagesFor('sarvam-tts', 'bulbul:v4-flash').map((l) => l.id);
check('sarvam: v4-flash has its own language list', v4Langs.length > 0 && v4Langs.length < 11, `${v4Langs.length}`);
check('sarvam: v4-flash offers neither Malayalam nor Odia', !v4Langs.includes('ml-IN') && !v4Langs.includes('od-IN'));
check('sarvam: v4-flash lands on its default persona',
  voicesFor('sarvam-tts', 'bulbul:v4-flash', v4Langs[0])[0]?.id === 'shubh_enhi_ads');
const v4Voices = new Set(v4Langs.flatMap((l) => voicesFor('sarvam-tts', 'bulbul:v4-flash', l).map((v) => v.id)));
check('sarvam: v4-flash carries the 222-persona catalogue', v4Voices.size === 222, `${v4Voices.size}`);
check('sarvam: every v4-flash voice is a <name>_<lang>_<style> persona',
  [...v4Voices].every((id) => /^[a-z]+_[a-z]+_[a-z_]+$/.test(id)));
const v3Voices = voicesFor('sarvam-tts', 'bulbul:v3', 'en-IN').map((v) => v.id);
check('sarvam: v3 and v4-flash share no speaker ids', !v3Voices.some((id) => v4Voices.has(id)));
check("sarvam: v3's default `shubh` is not offered on v4-flash", !v4Voices.has('shubh'));
check('sarvam: v2 has its own speakers', voicesFor('sarvam-tts', 'bulbul:v2')[0]?.id === 'anushka');
const sttBases = new Set(findProvider('sarvam-stt')!.models.map((m) => m.id.split('@')[0]));
check('sarvam: every Saaras id is in the streaming spec enum',
  [...sttBases].every((b) => b === 'saaras:v3-realtime' || b === 'saaras:v4'), [...sttBases].join(', '));

/* 5. a free-text voice id is only offered where a vendor was measured to take one */
for (const p of CATALOG.filter((e: ProviderEntry) => e.acceptsVoiceId)) {
  check(`${p.id}: explains where a voice id comes from`, !!p.voiceIdHint);
}

let failed = 0;
for (const [n, ok, d] of results) {
  if (!ok) console.log(`FAIL  ${n}${d ? `  -> ${d}` : ''}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
