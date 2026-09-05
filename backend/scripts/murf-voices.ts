/**
 * Lists the voices Murf actually exposes for this key and prints a catalog
 * block ready to paste into src/providers/catalog.ts.
 *
 *   npx tsx scripts/murf-voices.ts [locale-filter]
 */
import 'dotenv/config';

const KEY = process.env.MURF_API_KEY;
if (!KEY) {
  console.error('MURF_API_KEY is not set. Put it in backend/.env and re-run.');
  process.exit(1);
}

const filter = process.argv[2];

interface MurfVoice {
  voiceId?: string;
  voice_id?: string;
  displayName?: string;
  name?: string;
  locale?: string;
  displayLanguage?: string;
  availableStyles?: string[];
  supportedLocales?: unknown;
}

const res = await fetch('https://api.murf.ai/v1/speech/voices', { headers: { 'api-key': KEY } });
if (!res.ok) {
  console.error(`Murf ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

const body = (await res.json()) as MurfVoice[] | { voices?: MurfVoice[] };
const voices = Array.isArray(body) ? body : body.voices ?? [];
const rows = voices
  .map((v) => ({
    id: v.voiceId ?? v.voice_id ?? '',
    name: v.displayName ?? v.name ?? '',
    locale: v.locale ?? v.displayLanguage ?? '',
    styles: v.availableStyles ?? [],
    locales: v.supportedLocales,
  }))
  .filter((v) => v.id && (!filter || v.id.includes(filter) || v.locale.includes(filter)));

console.log(`${voices.length} voices total, ${rows.length} shown${filter ? ` (filter: ${filter})` : ''}\n`);
for (const v of rows.slice(0, 40)) {
  console.log(`  ${v.id.padEnd(26)} ${v.name.padEnd(18)} ${v.locale.padEnd(8)} styles=${v.styles.join(',') || '-'}`);
}

const locales = [...new Set(rows.map((v) => v.locale).filter(Boolean))].sort();
console.log(`\nlocales: ${locales.join(' ')}`);

console.log('\n--- paste into catalog.ts voices: [] ---');
for (const v of rows.slice(0, 12)) {
  const note = v.styles.length ? `, note: '${v.styles.slice(0, 3).join(' / ')}'` : '';
  console.log(`      { id: '${v.id}', name: '${v.name || v.id}'${note} },`);
}
process.exit(0);
