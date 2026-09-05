/**
 * Regenerates `src/providers/murf-catalog.ts` from Murf's live voice list.
 *
 * Falcon 2 and Gen2 each have their OWN voice catalog — 137 and 163 voices with
 * only 100 in common — and asking one model for the other's voice is a hard
 * error ("Invalid voice_id ... not supported for the selected model"). So the
 * list is fetched per model and the UI offers a voice list per model.
 *
 *   npx tsx scripts/murf-voices.ts            # rewrite the catalog module
 *   npx tsx scripts/murf-voices.ts --print    # print it instead, change nothing
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEY = process.env.MURF_API_KEY;
if (!KEY) {
  console.error('MURF_API_KEY is not set. Put it in backend/.env and re-run.');
  process.exit(1);
}

const OUT = fileURLToPath(new URL('../src/providers/murf-catalog.ts', import.meta.url));
const printOnly = process.argv.includes('--print');

interface MurfVoice {
  voiceId: string;
  displayName?: string;
  locale?: string;
  displayLanguage?: string;
  accent?: string;
  gender?: string;
  availableStyles?: string[] | null;
  supportedLocales?: Record<string, { detail?: string; availableStyles?: string[] }> | null;
}

async function fetchVoices(model: 'FALCON' | 'GEN2'): Promise<MurfVoice[]> {
  const res = await fetch(`https://api.murf.ai/v1/speech/voices?model=${model}`, {
    headers: { 'api-key': KEY! },
  });
  if (!res.ok) {
    console.error(`Murf ${res.status} for ${model}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const body = (await res.json()) as MurfVoice[] | { voices?: MurfVoice[] };
  return (Array.isArray(body) ? body : body.voices ?? []).filter((v) => v.voiceId);
}

/** English-first, then the rest alphabetically — the bench is driven in English most days. */
const LOCALE_ORDER = ['en-US', 'en-IN', 'en-UK', 'en-AU', 'hi-IN'];
const localeRank = (l: string) => {
  const i = LOCALE_ORDER.indexOf(l);
  return i === -1 ? LOCALE_ORDER.length : i;
};

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function voiceRows(voices: MurfVoice[]): string[] {
  const sorted = [...voices].sort((a, b) => {
    const la = a.locale ?? '';
    const lb = b.locale ?? '';
    if (localeRank(la) !== localeRank(lb)) return localeRank(la) - localeRank(lb);
    if (la !== lb) return la.localeCompare(lb);
    // Murf's flagship voice leads its locale, so it stays the default selection.
    if (a.voiceId === 'en-US-natalie') return -1;
    if (b.voiceId === 'en-US-natalie') return 1;
    return (a.displayName ?? a.voiceId).localeCompare(b.displayName ?? b.voiceId);
  });

  return sorted.map((v) => {
    const name = `${v.displayName ?? v.voiceId} · ${v.locale ?? '??'}`;
    const styles = (v.availableStyles ?? []).slice(0, 3).join(' / ');
    const extra = Object.keys(v.supportedLocales ?? {}).length - 1;
    const parts = [styles, extra > 0 ? `+${extra} locales` : ''].filter(Boolean);
    const note = parts.length ? `, note: '${esc(parts.join(' · '))}'` : '';
    return `  { id: '${esc(v.voiceId)}', name: '${esc(name)}'${note} },`;
  });
}

function localeRows(voices: MurfVoice[]): string[] {
  const names = new Map<string, string>();
  for (const v of voices) {
    // A multi-native voice can speak locales its own id does not name, so every
    // locale any voice supports belongs in the list.
    for (const [loc, meta] of Object.entries(v.supportedLocales ?? {})) {
      if (!names.has(loc)) names.set(loc, meta?.detail ?? v.displayLanguage ?? loc);
    }
    if (v.locale && !names.has(v.locale)) names.set(v.locale, v.displayLanguage ?? v.locale);
  }
  return [...names.entries()]
    .sort((a, b) => localeRank(a[0]) - localeRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([id, name]) => `  { id: '${esc(id)}', name: '${esc(name)} (${id})' },`);
}

const falcon = await fetchVoices('FALCON');
const gen2 = await fetchVoices('GEN2');

const header = `/**
 * Murf's voice catalogue, per model. GENERATED — do not hand-edit.
 *
 *   cd backend && npm run murf:voices
 *
 * Falcon 2 and Gen2 do not share a voice list: ${falcon.length} and ${gen2.length} voices with
 * ${falcon.filter((v) => gen2.some((g) => g.voiceId === v.voiceId)).length} in common. Offering one model the other's voice is a hard
 * error from the vendor, which is why these lists hang off the model rather than
 * off the provider. Read from the live API on ${new Date().toISOString().slice(0, 10)}.
 */

import type { ModelEntry } from './catalog.js';
`;

const body = [
  header,
  `export const MURF_FALCON_VOICES: ModelEntry[] = [`,
  ...voiceRows(falcon),
  `];`,
  ``,
  `export const MURF_FALCON_LOCALES: ModelEntry[] = [`,
  ...localeRows(falcon),
  `];`,
  ``,
  `export const MURF_GEN2_VOICES: ModelEntry[] = [`,
  ...voiceRows(gen2),
  `];`,
  ``,
  `export const MURF_GEN2_LOCALES: ModelEntry[] = [`,
  ...localeRows(gen2),
  `];`,
  ``,
].join('\n');

if (printOnly) {
  console.log(body);
} else {
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT}`);
}
console.log(
  `FALCON ${falcon.length} voices / ${localeRows(falcon).length} locales · ` +
    `GEN2 ${gen2.length} voices / ${localeRows(gen2).length} locales`,
);
process.exit(0);
