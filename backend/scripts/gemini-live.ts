/**
 * Live streaming check for GeminiLlmProvider — measures real TTFT through the
 * shipped provider for every catalog variant of a model (or all models).
 *
 *   npx tsx scripts/gemini-live.ts                     # every gemini-3.8-flash variant
 *   npx tsx scripts/gemini-live.ts gemini-3.1-flash-lite
 *   npx tsx scripts/gemini-live.ts all                 # every verified combination
 */
import 'dotenv/config';
import { GeminiLlmProvider } from '../src/providers/llm/GeminiLlmProvider.js';
import { findProvider } from '../src/providers/catalog.js';

const arg = process.argv[2] ?? 'gemini-3.8-flash';
const PROMPT = process.env.PROMPT ?? 'A caller asks what your refund window is. Reply in one short sentence.';
const SYSTEM = 'You are a terse voice assistant. One short sentence, no lists.';

if (!process.env.GOOGLE_API_KEY) {
  console.error('GOOGLE_API_KEY is not set. Put it in backend/.env and re-run.');
  process.exit(1);
}

const all = (findProvider('google-llm')?.models ?? []).map((m) => m.id);
const targets = arg === 'all' ? all : all.filter((id) => id.startsWith(`${arg}@`));

if (targets.length === 0) {
  console.error(`No catalog variants for "${arg}". Known models:`);
  console.error('  ' + [...new Set(all.map((id) => id.split('@')[0]))].join('\n  '));
  process.exit(1);
}

const provider = new GeminiLlmProvider();
const credentials = { ...process.env };

interface Result { id: string; ttft?: number; total?: number; text: string; error?: string }

async function measure(id: string): Promise<Result> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let ttft: number | undefined;
    let text = '';
    let error: string | undefined;

    provider.stream(
      { model: id, credentials },
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: PROMPT },
      ],
      {
        onDelta: (d) => {
          ttft ??= performance.now() - t0;
          text += d;
        },
        onDone: (full) => resolve({ id, ttft, total: performance.now() - t0, text: full || text, error }),
        onError: (e) => (error = e.message),
      },
    );
  });
}

console.log(`prompt: "${PROMPT}"\n`);
const results: Result[] = [];
for (const id of targets) {
  const r = await measure(id);
  results.push(r);
  const ttft = r.ttft === undefined ? '   -' : `${Math.round(r.ttft)}`.padStart(4);
  const total = r.total === undefined ? '   -' : `${Math.round(r.total)}`.padStart(5);
  console.log(
    `${r.error ? 'FAIL' : 'ok  '} ${id.padEnd(32)} ttft=${ttft}ms total=${total}ms  ${r.error ?? JSON.stringify(r.text.slice(0, 58))}`,
  );
}

const ok = results.filter((r) => !r.error && r.ttft !== undefined);
console.log(`\n${ok.length}/${results.length} variants streamed successfully`);
if (ok.length) {
  const best = ok.reduce((a, b) => (a.ttft! < b.ttft! ? a : b));
  console.log(`lowest TTFT: ${best.id} at ${Math.round(best.ttft!)}ms`);
}
process.exit(ok.length === results.length ? 0 : 1);
