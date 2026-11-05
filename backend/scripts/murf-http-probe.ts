/**
 * Asks Murf's HTTP streaming endpoint the questions its docs leave open, for the
 * path `MurfTtsProvider` sends Falcon down:
 *
 *   POST https://in.api.murf.ai/v1/speech/stream     header: api-key
 *
 * The provider's HTTP shape was written from the docs on 2026-11-05 with no key,
 * so until this has run, NONE of the following is established:
 *
 *   1. that the India host accepts our exact body (format=PCM, sampleRate=24000,
 *      channelType=MONO, model=falcon-2.1, locale) — status and vendor text
 *   2. which region actually served it (`X-Murf-Region`) and the concurrency
 *      headers the rate-limits page documents
 *   3. what the bytes are: Content-Type, and whether a RIFF header precedes PCM
 *      (documented as headerless only on the WebSocket page)
 *   4. TTFB from this machine, India host vs the global one, median of 3 —
 *      the number to put beside the WebSocket path's measured ~186ms
 *   5. whether `falcon-2` (what the old WebSocket path sent) is still accepted
 *   6. what the India host says to `gen2` (the provider keeps Gen2 on the US
 *      WebSocket; this records the refusal text, if it is one)
 *
 * Every request bills a few dozen characters. Run it before quoting any number
 * for the HTTP path.
 *
 *   npm run murf:http:probe
 *   MURF_HTTP_URL=https://us-east.api.murf.ai/v1/speech/stream npm run murf:http:probe
 */
import 'dotenv/config';
import { pcm16DurationMs, stripWavHeader } from '../src/audio/pcm.js';

const KEY = process.env.MURF_API_KEY;
if (!KEY) {
  console.error('MURF_API_KEY is not set. Put it in backend/.env and re-run.');
  process.exit(1);
}

const IN = process.env.MURF_HTTP_URL ?? 'https://in.api.murf.ai/v1/speech/stream';
const GLOBAL = 'https://global.api.murf.ai/v1/speech/stream';
const TEXT = 'Our refund window is thirty days from the date of purchase.';
const VOICE = process.env.MURF_VOICE ?? 'en-US-natalie';
const RUNS = 3;

interface Result {
  status: number;
  ttfb?: number;
  total: number;
  bytes: number;
  /** Audio after any RIFF header, at the requested 24 kHz. */
  audioMs: number;
  riff: boolean;
  headers: Record<string, string>;
  error?: string;
}

async function post(url: string, body: Record<string, unknown>): Promise<Result> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': KEY! },
    body: JSON.stringify(body),
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of res.headers) {
    if (k.startsWith('x-murf') || k === 'content-type' || k === 'retry-after' || k === 'transfer-encoding') {
      headers[k] = v;
    }
  }
  if (!res.ok || !res.body) {
    return { status: res.status, total: performance.now() - t0, bytes: 0, audioMs: 0, riff: false, headers, error: await res.text() };
  }
  let ttfb: number | undefined;
  const chunks: Buffer[] = [];
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    ttfb ??= performance.now() - t0;
    chunks.push(Buffer.from(c));
  }
  const all = Buffer.concat(chunks);
  return {
    status: res.status,
    ttfb,
    total: performance.now() - t0,
    bytes: all.length,
    audioMs: Math.round(pcm16DurationMs(stripWavHeader(all).length, 24000)),
    riff: all.subarray(0, 4).toString('ascii') === 'RIFF',
    headers,
  };
}

const body = (o: Record<string, unknown> = {}) => ({
  text: TEXT,
  voiceId: VOICE,
  model: 'falcon-2.1',
  format: 'PCM',
  sampleRate: 24000,
  channelType: 'MONO',
  rate: 0,
  pitch: 0,
  style: 'Conversational',
  locale: 'en-US',
  ...o,
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const show = (label: string, r: Result) => {
  console.log(
    `${label.padEnd(34)} ${r.status}  ttfb=${r.ttfb?.toFixed(0) ?? '-'}ms  total=${r.total.toFixed(0)}ms  ` +
      `bytes=${r.bytes} (${r.audioMs}ms @24k)  riff=${r.riff}  ${JSON.stringify(r.headers)}` +
      (r.error ? `\n${' '.repeat(36)}vendor said: ${r.error.slice(0, 400)}` : ''),
  );
};

console.log(`Murf HTTP probe — ${new Date().toISOString()}\nvoice=${VOICE}  text=${JSON.stringify(TEXT)}\n`);

console.log('1-3. the provider\'s exact request, India host');
const first = await post(IN, body());
show(IN, first);

console.log(`\n4. TTFB, median of ${RUNS} (connection reuse is up to fetch, as in the provider)`);
for (const url of [IN, GLOBAL]) {
  const rs: Result[] = [];
  for (let i = 0; i < RUNS; i++) rs.push(await post(url, body()));
  for (const [i, r] of rs.entries()) show(`  ${new URL(url).host} #${i + 1}`, r);
  const ok = rs.filter((r) => r.ttfb !== undefined).map((r) => r.ttfb!);
  console.log(`  -> median TTFB ${ok.length ? median(ok).toFixed(0) : '-'}ms over ${ok.length}/${RUNS} successful\n`);
}

console.log('5. the older model spelling');
show('model=falcon-2', await post(IN, body({ model: 'falcon-2' })));

console.log('\n6. gen2 on the India host');
show('model=gen2', await post(IN, body({ model: 'gen2' })));
