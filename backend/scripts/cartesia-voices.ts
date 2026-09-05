/**
 * Regenerates `src/providers/cartesia-catalog.ts` — Cartesia's whole voice
 * library, grouped by language, plus the languages each Sonic model accepts.
 *
 *   npx tsx scripts/cartesia-voices.ts           # fetch voices + probe languages
 *   npx tsx scripts/cartesia-voices.ts --fast    # fetch voices, keep the language table
 *
 * Two things this settles that no doc page does:
 *
 *   · The library is ~930 voices across 44 languages (49 in Hindi alone). The
 *     eight ids that used to be hand-listed here were a rounding error.
 *   · Language support is PER MODEL and the spread is enormous — sonic-3.6 takes
 *     all 44, sonic-3/3.5 all but `or` and `ur`, sonic-turbo 9, sonic-2 8. The
 *     probe sends one short utterance per model/language pair and records what
 *     the API answers, so the catalog can never offer a combination that 400s.
 *
 * A voice is NOT bound to its language: an English voice speaking Hindi is
 * accepted (measured), so the grouping is for navigating ~930 options, not a
 * constraint. Paste any id into the UI's Voice id field to cross the grouping.
 */
import 'dotenv/config';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEY = process.env.CARTESIA_API_KEY;
if (!KEY) {
  console.error('CARTESIA_API_KEY is not set. Put it in backend/.env and re-run.');
  process.exit(1);
}

const VERSION = '2026-08-14';
const OUT = fileURLToPath(new URL('../src/providers/cartesia-catalog.ts', import.meta.url));
const fast = process.argv.includes('--fast');
/** Every Sonic model in the catalog. Keep in step with catalog.ts. */
const MODELS = ['sonic-3.6', 'sonic-3.5', 'sonic-3', 'sonic-turbo', 'sonic-2'];

interface CartesiaVoice {
  id: string;
  name?: string;
  description?: string;
  language?: string;
  gender?: string;
  is_archived?: boolean;
}

/** ISO-639-1 -> the name shown in the picker. Anything unlisted shows its code. */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', kn: 'Kannada',
  ml: 'Malayalam', mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi', or: 'Odia', ur: 'Urdu',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch',
  pl: 'Polish', ru: 'Russian', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew', ja: 'Japanese',
  ko: 'Korean', zh: 'Chinese', vi: 'Vietnamese', id: 'Indonesian', th: 'Thai', tl: 'Tagalog',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech', sk: 'Slovak',
  hu: 'Hungarian', ro: 'Romanian', bg: 'Bulgarian', hr: 'Croatian', el: 'Greek',
  uk: 'Ukrainian', ka: 'Georgian', ms: 'Malay',
};

/** English first, then the languages this bench is actually run in, then the rest. */
const LANGUAGE_ORDER = ['en', 'hi', 'ta', 'te', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'or', 'ur'];
const langRank = (l: string) => {
  const i = LANGUAGE_ORDER.indexOf(l);
  return i === -1 ? LANGUAGE_ORDER.length : i;
};
const byLang = (a: string, b: string) => langRank(a) - langRank(b) || a.localeCompare(b);
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const gender = (g?: string) => (g === 'feminine' ? 'F' : g === 'masculine' ? 'M' : g ? g[0].toUpperCase() : '');

async function fetchVoices(): Promise<CartesiaVoice[]> {
  // Paginated since Cartesia-Version 2026-08-14: 10 at a time unless asked, and
  // `next_page` is the id to start after. Without this you get the first page and
  // conclude the library has ten English voices in it.
  const all: CartesiaVoice[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ limit: '100', ...(after ? { starting_after: after } : {}) });
    const res = await fetch(`https://api.cartesia.ai/voices/?${params}`, {
      headers: { 'X-API-Key': KEY!, 'Cartesia-Version': VERSION },
    });
    if (!res.ok) {
      console.error(`Cartesia ${res.status}: ${(await res.text()).slice(0, 300)}`);
      process.exit(1);
    }
    const body = (await res.json()) as { data?: CartesiaVoice[]; has_more?: boolean; next_page?: string };
    all.push(...(body.data ?? []));
    if (!body.has_more || !body.next_page) break;
    after = body.next_page;
  }
  return all.filter((v) => v.id && v.language && !v.is_archived);
}

/** One short utterance per model/language pair: does the API take it, yes or no? */
function accepts(model: string, language: string, voice: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`, {
      headers: { 'X-API-Key': KEY!, 'Cartesia-Version': VERSION },
    });
    let bytes = 0;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(bytes > 0), 20_000);
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          model_id: model,
          transcript: 'Hello there.',
          voice: { mode: 'id', id: voice },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
          context_id: randomUUID(),
          language,
          continue: false,
        }),
      ),
    );
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type?: string; data?: string };
      if (m.type === 'error') return done(false);
      if (m.type === 'chunk' && m.data) bytes += m.data.length;
      if (m.type === 'done') done(bytes > 0);
    });
    ws.on('error', () => done(false));
    ws.on('close', () => done(bytes > 0));
  });
}

const voices = await fetchVoices();
const groups = new Map<string, CartesiaVoice[]>();
for (const v of voices) {
  const list = groups.get(v.language!) ?? [];
  list.push(v);
  groups.set(v.language!, list);
}
const languages = [...groups.keys()].sort(byLang);

let modelLanguages: Record<string, string[]>;
if (fast) {
  const current = (await import('../src/providers/cartesia-catalog.js')) as {
    CARTESIA_MODEL_LANGUAGES: Record<string, string[]>;
  };
  modelLanguages = current.CARTESIA_MODEL_LANGUAGES;
  console.log('--fast: keeping the language table already on disk');
} else {
  modelLanguages = {};
  for (const model of MODELS) {
    const ok: string[] = [];
    for (const language of languages) {
      if (await accepts(model, language, groups.get(language)![0].id)) ok.push(language);
    }
    modelLanguages[model] = ok;
    console.log(`${model.padEnd(12)} ${ok.length}/${languages.length} languages: ${ok.join(' ')}`);
  }
}

const voiceRows = (list: CartesiaVoice[]) =>
  [...list]
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
    .map((v) => {
      const g = gender(v.gender);
      const name = `${v.name ?? v.id}${g ? ` (${g})` : ''}`;
      const desc = (v.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return `    { id: '${esc(v.id)}', name: '${esc(name)}'${desc ? `, note: '${esc(desc)}'` : ''} },`;
    });

const body = [
  `/**`,
  ` * Cartesia's voice library and per-model language support. GENERATED — do not hand-edit.`,
  ` *`,
  ` *   cd backend && npm run cartesia:voices`,
  ` *`,
  ` * ${voices.length} voices across ${languages.length} languages, read from GET /voices on ${new Date().toISOString().slice(0, 10)}.`,
  ` * The language table below is measured, not documented: one live utterance per`,
  ` * model/language pair, so the UI cannot offer a combination the API refuses.`,
  ` * A voice is not bound to its language — the grouping is for navigating ${voices.length}`,
  ` * options, and any id can be pasted into the UI's Voice id field to cross it.`,
  ` */`,
  ``,
  `import type { ModelEntry } from './catalog.js';`,
  ``,
  `export const CARTESIA_LANGUAGE_NAMES: Record<string, string> = {`,
  ...languages.map((l) => `  ${l}: '${esc(LANGUAGE_NAMES[l] ?? l)}',`),
  `};`,
  ``,
  `export const CARTESIA_VOICES_BY_LANGUAGE: Record<string, ModelEntry[]> = {`,
  ...languages.flatMap((l) => [
    `  ${l}: [`,
    ...voiceRows(groups.get(l)!),
    `  ],`,
  ]),
  `};`,
  ``,
  `/** Languages each model accepted live. Re-measure with \`npm run cartesia:voices\`. */`,
  `export const CARTESIA_MODEL_LANGUAGES: Record<string, string[]> = {`,
  ...MODELS.map((m) => `  '${m}': [${(modelLanguages[m] ?? []).map((l) => `'${l}'`).join(', ')}],`),
  `};`,
  ``,
].join('\n');

writeFileSync(OUT, body);
console.log(`\nwrote ${OUT}`);
console.log(
  `${voices.length} voices · ${languages.length} languages · ` +
    languages.slice(0, 6).map((l) => `${l}:${groups.get(l)!.length}`).join(' ') + ' …',
);
process.exit(0);
