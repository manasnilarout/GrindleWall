/**
 * Regenerates `src/providers/sarvam-catalog.ts` — Bulbul v4 Flash's voice
 * catalogue — from Sarvam's published Voices guide. No key needed.
 *
 *   npx tsx scripts/sarvam-voices.ts            # rewrite the catalog module
 *   npx tsx scripts/sarvam-voices.ts --print    # print it instead, change nothing
 *
 * `bulbul:v4-flash` does not share bulbul:v3's speakers: it takes ~222 persona
 * ids of the form `<name>_<language>_<style>` (`simran_en_customer`), and the
 * docs say v3's names — including v3's default `shubh` — are not valid on it.
 * So the list hangs off the model, filed per language, the way Murf's and
 * Cartesia's do.
 *
 * WHAT THIS IS NOT: Murf's and Cartesia's tables are read from the vendor's API.
 * Sarvam publishes no voice-listing endpoint we know of, so this one is parsed out
 * of a documentation page. It is exactly as good as that page; `npm run sarvam`
 * with a v4 persona is the only check that the API agrees with it.
 *
 * It also prints the streaming spec's `model` enum, because that is the evidence
 * for which Bulbul ids the WebSocket currently documents.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VOICES_URL = 'https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/voices.md';
const STREAM_SPEC_URL = 'https://docs.sarvam.ai/api-reference/text-to-speech/stream.md';
const OUT = fileURLToPath(new URL('../src/providers/sarvam-catalog.ts', import.meta.url));
const printOnly = process.argv.includes('--print');

/** Sarvam's default persona when `speaker` is omitted on bulbul:v4-flash. */
const DEFAULT_PERSONA = 'shubh_enhi_ads';

/** Same order as the v3 language list in catalog.ts, minus what v4 Flash lacks. */
const LANGUAGE_ORDER = ['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'gu-IN', 'pa-IN', 'od-IN'];

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

/**
 * Splits the "Bulbul v4 Flash Voices" section into one table per `####` heading.
 * A heading with a BCP-47 code in parentheses is a language; the code-mixed
 * table has none, and is returned under `null`.
 */
function parseVoices(md: string): { byLanguage: Map<string, { name: string; voices: Voice[] }>; mixed: Voice[] } {
  const start = md.indexOf('## Bulbul v4 Flash Voices');
  if (start < 0) throw new Error('Voices page has no "Bulbul v4 Flash Voices" section — the page changed shape');
  const end = md.indexOf('\n## ', start + 5);
  const section = md.slice(start, end < 0 ? undefined : end);

  const byLanguage = new Map<string, { name: string; voices: Voice[] }>();
  let mixed: Voice[] = [];
  let current: Voice[] | null = null;

  for (const line of section.split('\n')) {
    const heading = line.match(/^####\s+(.+?)\s*$/);
    if (heading) {
      const lang = heading[1].match(/^(.+?)\s+\(([a-z]{2,3}-[A-Z]{2})\)/);
      if (lang) {
        current = [];
        byLanguage.set(lang[2], { name: lang[1], voices: current });
      } else if (/code-mixed/i.test(heading[1])) {
        current = mixed = [];
      } else {
        current = null;
      }
      continue;
    }
    const row = line.match(/^\|\s*`([a-z0-9_]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (row && current) current.push({ id: row[1], speaker: row[2], style: row[3] });
  }
  return { byLanguage, mixed };
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function row(v: Voice, mixed: boolean): string {
  const name = `${v.speaker} · ${v.style}${mixed ? ' (Hinglish)' : ''}`;
  const note = v.id === DEFAULT_PERSONA ? `, note: 'Sarvam default persona'` : '';
  return `      { id: '${esc(v.id)}', name: '${esc(name)}'${note} },`;
}

const [voicesMd, specMd] = await Promise.all([get(VOICES_URL), get(STREAM_SPEC_URL)]);
const { byLanguage, mixed } = parseVoices(voicesMd);

// The persona's language tag must agree with the table it is filed under, or the
// page has been misparsed (or misfiled) and the output should not be trusted.
const tagOf = (id: string) => id.split('_')[1];
for (const [code, { voices }] of byLanguage) {
  const bad = voices.filter((v) => tagOf(v.id) !== code.slice(0, 2));
  if (bad.length) console.warn(`warning: ${code} lists ${bad.map((v) => v.id).join(', ')}`);
}
const badMixed = mixed.filter((v) => tagOf(v.id) !== 'enhi');
if (badMixed.length) console.warn(`warning: code-mixed lists ${badMixed.map((v) => v.id).join(', ')}`);

const all = [...[...byLanguage.values()].flatMap((l) => l.voices), ...mixed];
const unique = new Set(all.map((v) => v.id));
if (unique.size !== all.length) console.warn(`warning: ${all.length - unique.size} duplicate ids on the page`);
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
  return [`  {`, `    id: '${code}',`, `    name: '${esc(name)}',`, `    voices: [`, ...rows, `    ],`, `  },`].join('\n');
});

const modelEnum = specMd.match(/enum:\s*\n((?:\s+- bulbul:[^\n]+\n)+)/)?.[1]
  .split('\n').map((s) => s.replace(/^\s*-\s*/, '').trim()).filter(Boolean) ?? [];
const today = new Date().toISOString().slice(0, 10);

const body = `/**
 * Sarvam Bulbul v4 Flash's voice catalogue, per language. GENERATED — do not hand-edit.
 *
 *   cd backend && npm run sarvam:voices
 *
 * DOC-DERIVED, not measured: parsed from Sarvam's Voices guide
 * (${VOICES_URL}) on ${today}.
 * Sarvam publishes no voice-listing endpoint, so unlike the Murf and Cartesia
 * tables nothing here was read from the API. ${unique.size} persona ids: ${unique.size - mixed.length} filed
 * under ${codes.length} languages, and ${mixed.length} English–Hindi code-mixed (\`enhi\`) personas
 * that have no language code of their own and are offered under both en-IN and
 * hi-IN. v3's speaker names (\`shubh\`, \`ritu\`, …) are documented as invalid
 * on this model, which is why the list hangs off the model.
 */

import type { ModelEntry } from './catalog.js';

export const SARVAM_V4_FLASH_DEFAULT_VOICE = '${DEFAULT_PERSONA}';

export const SARVAM_V4_FLASH_LANGUAGES: ModelEntry[] = [
${languageBlocks.join('\n')}
];
`;

console.log(`streaming spec model enum: ${modelEnum.join(', ') || '(not found)'}`);
console.log(`${unique.size} personas · languages: ${codes.join(', ')} · code-mixed: ${mixed.length}`);
for (const code of codes) console.log(`  ${code}: ${byLanguage.get(code)!.voices.length}`);

if (printOnly) {
  console.log(body);
} else {
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
}
