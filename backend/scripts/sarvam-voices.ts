/**
 * Regenerates `src/providers/sarvam-catalog.ts` — Bulbul v4 Flash's voice
 * catalogue — from Sarvam's published Voices guide. No key needed.
 *
 *   npx tsx scripts/sarvam-voices.ts            # rewrite the catalog module
 *   npx tsx scripts/sarvam-voices.ts --print    # print it instead, change nothing
 *
 * With SARVAM_API_KEY set it also asks the API: one REST request with a speaker
 * that cannot exist, which Sarvam's v4 Flash best-practices page says returns
 * 400 "with the live speaker list". That list is diffed against the table and
 * printed; it never rewrites the table. A 400 is the expected answer, so this
 * should bill nothing — but it has never been run (no key here yet), so the
 * shape of that 400 is a guess until it is.
 *
 * `bulbul:v4-flash` does not share bulbul:v3's speakers: it takes ~222 persona
 * ids of the form `<name>_<language>_<style>` (`simran_en_customer`), and the
 * docs say v3's names — including v3's default `shubh` — are not valid on it.
 * So the list hangs off the model, filed per language, the way Murf's and
 * Cartesia's do.
 *
 * WHAT THIS IS NOT: Murf's and Cartesia's tables are read from a voice-listing
 * endpoint. We know of no such endpoint for Sarvam, so this table is parsed out of
 * a documentation page and is exactly as good as that page. The keyed cross-check
 * above, and `npm run sarvam` with a v4 persona, are what turn it into evidence.
 *
 * The page is checked against the streaming spec on the way through: a language
 * the socket's `language_code` enum does not list is dropped (the best-practices
 * roster already has two Assamese personas while `as-IN` is not an accepted code),
 * and persona ids are diffed against the spec's `speaker` enum. It also prints the
 * spec's `model` enum, the evidence for which Bulbul ids the socket documents.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VOICES_URL = 'https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices.md';
const STREAM_SPEC_URL = 'https://docs.sarvam.ai/api-reference/text-to-speech/stream.md';
const REST_URL = 'https://api.sarvam.ai/text-to-speech';
const OUT = fileURLToPath(new URL('../src/providers/sarvam-catalog.ts', import.meta.url));
const printOnly = process.argv.includes('--print');

/** Sarvam's default persona when `speaker` is omitted on bulbul:v4-flash. */
const DEFAULT_PERSONA = 'shubh_enhi_ads';

/**
 * Display order and names follow the v3 language list in catalog.ts, so the two
 * models read alike. Only languages the page has personas for are emitted, so
 * ml-IN / od-IN here are just ordering slots until Sarvam publishes some.
 */
const LANGUAGE_ORDER = ['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'gu-IN', 'pa-IN', 'od-IN'];
const LANGUAGE_NAMES: Record<string, string> = { 'en-IN': 'English (India)' };

interface Voice {
  id: string;
  speaker: string;
  style: string;
}

async function get(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`${res.status} for ${url}`);
    process.exit(1);
  }
  return res.text();
}

/** The `enum:` list of the spec schema whose name ends in `schemaSuffix`. */
function specEnum(spec: string, schemaSuffix: string): string[] {
  const at = spec.search(new RegExp(`\\n\\s+\\w*${schemaSuffix}:\\s*\\n\\s+type: string\\s*\\n\\s+enum:`));
  if (at < 0) return [];
  const body = spec.slice(spec.indexOf('enum:', at) + 5);
  const values: string[] = [];
  for (const line of body.split('\n').slice(1)) {
    const m = line.match(/^\s+-\s+'?([^'\s]+)'?\s*$/);
    if (!m) break;
    values.push(m[1]);
  }
  return values;
}

/**
 * Splits the "Bulbul v4 Flash Voices" section into one table per `####` heading.
 * A heading with a BCP-47 code in parentheses is a language; the code-mixed
 * table has none, and is returned under `null`.
 */
function parseVoices(md: string): {
  byLanguage: Map<string, { name: string; voices: Voice[] }>;
  mixed: Voice[];
  problems: string[];
} {
  const start = md.indexOf('## Bulbul v4 Flash Voices');
  if (start < 0) throw new Error('Voices page has no "Bulbul v4 Flash Voices" section — the page changed shape');
  const end = md.indexOf('\n## ', start + 5);
  const section = md.slice(start, end < 0 ? undefined : end);

  const byLanguage = new Map<string, { name: string; voices: Voice[] }>();
  const mixed: Voice[] = [];
  const problems: string[] = [];
  /** Each heading states its own count — "Hindi (hi-IN) (116 voices)" — a free check on the parse. */
  const stated: Array<{ heading: string; count: number; voices: Voice[] }> = [];
  let current: Voice[] | null = null;

  for (const line of section.split('\n')) {
    const heading = line.match(/^####\s+(.+?)\s*$/);
    if (heading) {
      const lang = heading[1].match(/^(.+?)\s+\(([a-z]{2,3}-[A-Z]{2})\)/);
      if (lang) {
        if (byLanguage.has(lang[2])) problems.push(`two tables for ${lang[2]}`);
        current = [];
        byLanguage.set(lang[2], { name: lang[1], voices: current });
      } else if (/code-mixed/i.test(heading[1])) {
        // Only the English–Hindi table is understood. A second mixed table would
        // otherwise be poured into the Hinglish list under the wrong languages.
        if (!/hindi-english|english-hindi/i.test(heading[1]) || mixed.length) {
          problems.push(`unrecognised code-mixed table "${heading[1]}" — teach this script where it belongs`);
          current = null;
        } else {
          current = mixed;
        }
      } else {
        current = null;
      }
      const count = heading[1].match(/\((\d+) voices\)/);
      if (count && current) stated.push({ heading: heading[1], count: Number(count[1]), voices: current });
      continue;
    }
    const row = line.match(/^\|\s*`([a-z0-9_]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (row && current) current.push({ id: row[1], speaker: row[2], style: row[3] });
  }
  for (const { heading, count, voices } of stated) {
    if (voices.length !== count) problems.push(`"${heading}" says ${count} voices, parsed ${voices.length}`);
  }
  for (const [code, { voices }] of byLanguage) if (voices.length === 0) problems.push(`${code} parsed to an empty table`);
  return { byLanguage, mixed, problems };
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function row(v: Voice, mixed: boolean): string {
  const name = `${v.speaker} · ${v.style}${mixed ? ' (Hinglish)' : ''}`;
  const note = v.id === DEFAULT_PERSONA ? `, note: 'Sarvam default persona'` : '';
  return `      { id: '${esc(v.id)}', name: '${esc(name)}'${note} },`;
}

const [voicesMd, specMd] = await Promise.all([get(VOICES_URL), get(STREAM_SPEC_URL)]);
const { byLanguage, mixed, problems } = parseVoices(voicesMd);
if (byLanguage.size === 0) {
  console.error('parsed no language tables out of the Voices page — it changed shape; refusing to write an empty table');
  process.exit(1);
}

const modelEnum = specEnum(specMd, 'Model');
const languageEnum = specEnum(specMd, 'LanguageCode');
const speakerEnum = new Set(specEnum(specMd, 'Speaker'));
if (!languageEnum.length || !speakerEnum.size) {
  console.error('could not read the language_code / speaker enums out of the streaming spec — it changed shape');
  process.exit(1);
}
// A table for a language the socket does not accept would put a 400 in the UI.
for (const code of [...byLanguage.keys()]) {
  if (!languageEnum.includes(code)) {
    console.warn(`warning: dropping ${code} (${byLanguage.get(code)!.voices.length} voices) — not in the spec's language_code enum`);
    byLanguage.delete(code);
  }
}

// The persona's language tag must agree with the table it is filed under, or the
// page has been misparsed (or misfiled) and the output should not be trusted.
const tagOf = (id: string) => id.split('_')[1];
for (const [code, { voices }] of byLanguage) {
  const bad = voices.filter((v) => tagOf(v.id) !== code.split('-')[0]);
  if (bad.length) problems.push(`${code} lists ${bad.map((v) => v.id).join(', ')}`);
}
const badMixed = mixed.filter((v) => tagOf(v.id) !== 'enhi');
if (badMixed.length) problems.push(`code-mixed lists ${badMixed.map((v) => v.id).join(', ')}`);

const all = [...[...byLanguage.values()].flatMap((l) => l.voices), ...mixed];
const unique = new Set(all.map((v) => v.id));
if (unique.size !== all.length) problems.push(`${all.length - unique.size} duplicate ids on the page`);
if (problems.length) {
  console.error(`refusing to write the table:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
// The spec's speaker enum also carries v2/v3's plain names; only persona-shaped
// ids are comparable with this table.
const specPersonas = new Set([...speakerEnum].filter((id) => id.includes('_')));
const notInSpec = [...unique].filter((id) => !specPersonas.has(id));
const notOnPage = [...specPersonas].filter((id) => !unique.has(id));
if (notInSpec.length) console.warn(`warning: on the page, not in the spec's speaker enum: ${notInSpec.join(', ')}`);
if (notOnPage.length) console.warn(`warning: in the spec's speaker enum, not on the page: ${notOnPage.join(', ')}`);
if (!unique.has(DEFAULT_PERSONA)) {
  console.error(`${DEFAULT_PERSONA} is not on the voices page — the default persona changed; update DEFAULT_PERSONA`);
  process.exit(1);
}

const codes = [...byLanguage.keys()].sort((a, b) => {
  const ra = LANGUAGE_ORDER.indexOf(a);
  const rb = LANGUAGE_ORDER.indexOf(b);
  return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
});

// Code-mixed personas have no language code of their own; Sarvam's examples send
// them with `hi-IN`, and the default persona is used with `en-IN`. So they are
// offered under both. In English the default persona leads, so it is what the
// dropdown lands on.
const languageBlocks = codes.map((code) => {
  const { name, voices } = byLanguage.get(code)!;
  let rows: string[];
  if (code === 'en-IN') {
    const lead = mixed.filter((v) => v.id === DEFAULT_PERSONA);
    const rest = mixed.filter((v) => v.id !== DEFAULT_PERSONA);
    rows = [...lead.map((v) => row(v, true)), ...voices.map((v) => row(v, false)), ...rest.map((v) => row(v, true))];
  } else if (code === 'hi-IN') {
    rows = [...voices.map((v) => row(v, false)), ...mixed.map((v) => row(v, true))];
  } else {
    rows = voices.map((v) => row(v, false));
  }
  return [`  {`, `    id: '${code}',`, `    name: '${esc(LANGUAGE_NAMES[code] ?? name)}',`, `    voices: [`, ...rows, `    ],`, `  },`].join('\n');
});

const today = new Date().toISOString().slice(0, 10);

const body = `/**
 * Sarvam Bulbul v4 Flash's voice catalogue, per language. GENERATED — do not hand-edit.
 *
 *   cd backend && npm run sarvam:voices
 *
 * DOC-DERIVED, not measured: parsed from Sarvam's Voices guide
 * (${VOICES_URL}) on ${today}.
 * Unlike the Murf and Cartesia tables nothing here was read from the API.
 *
 * ${unique.size} persona ids on that page — the streaming spec's speaker enum lists the
 * same ${specPersonas.size}, while Sarvam's best-practices page and launch blog say 224
 * (its roster adds two Assamese personas whose code is not yet accepted). Of
 * those, ${unique.size - mixed.length} are filed under the ${codes.length} languages that HAVE personas — the
 * spec's language_code enum also lists ml-IN and od-IN — and ${mixed.length} are English–Hindi
 * code-mixed (\`enhi\`) personas with no language code of their own. Offering
 * those under both en-IN and hi-IN is this bench's choice; Sarvam's examples
 * send them as hi-IN. v3's speaker names (\`shubh\`, \`ritu\`, …) are documented
 * as invalid on this model, which is why the list hangs off the model.
 */

import type { ModelEntry } from './catalog.js';

export const SARVAM_V4_FLASH_DEFAULT_VOICE = '${DEFAULT_PERSONA}';

export const SARVAM_V4_FLASH_LANGUAGES: ModelEntry[] = [
${languageBlocks.join('\n')}
];
`;

console.log(`streaming spec model enum: ${modelEnum.join(', ') || '(not found)'}`);
console.log(`streaming spec language_code enum: ${languageEnum.join(', ')}`);
console.log(`streaming spec speaker enum: ${specPersonas.size} personas (page: ${unique.size})`);
console.log(`${unique.size} personas · languages: ${codes.join(', ')} · code-mixed: ${mixed.length}`);
for (const code of codes) console.log(`  ${code}: ${byLanguage.get(code)!.voices.length}`);

/**
 * Optional, keyed: what the API itself says the speakers are. The 400's exact
 * shape is undocumented, so every persona-shaped token in the body is taken as
 * the list; if none is found the body is printed for a human to read.
 */
const key = process.env.SARVAM_API_KEY;
if (key) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi', model: 'bulbul:v4-flash', language_code: 'en-IN', speaker: 'zz_not_a_speaker_probe' }),
  });
  const text = await res.text();
  const live = new Set([...text.matchAll(/\b[a-z]+_[a-z]+_[a-z_]*[a-z]\b/g)].map((m) => m[0]).filter((id) => id !== 'zz_not_a_speaker_probe'));
  console.log(`\nlive check: HTTP ${res.status}, ${live.size} persona ids in the response`);
  if (live.size === 0) {
    console.log(text.slice(0, 600));
  } else {
    const missing = [...unique].filter((id) => !live.has(id));
    const extra = [...live].filter((id) => !unique.has(id));
    console.log(missing.length ? `  in the table, NOT accepted by the API: ${missing.join(', ')}` : '  every table id is in the API list');
    console.log(extra.length ? `  accepted by the API, not in the table: ${extra.join(', ')}` : '  the API lists nothing the table lacks');
  }
} else {
  console.log('\n(no SARVAM_API_KEY — skipped the live speaker-list check)');
}

if (printOnly) {
  console.log(body);
} else {
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
}
