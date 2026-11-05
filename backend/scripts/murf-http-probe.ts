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
 *   4. TTFB from this machine, India host vs the global one. The FIRST request to
 *      each host is cold (DNS+TCP+TLS, comparable to the WebSocket path's ~186ms
 *      "full open+synthesise"); the rest reuse fetch's kept-alive connection and
 *      are comparable to its ~90ms socket-warm figure. Both are printed.
 *   5. whether audio streams faster than real time. The provider sends segments
 *      one at a time, so a segment's successor only starts once its whole
 *      response has arrived; if Murf paces at ~1x, every segment boundary is a
 *      silent gap. Section 7 measures that gap directly.
 *   6. whether `falcon-2` (what the old WebSocket path sent) is still accepted,
 *      and what the India host says to `gen2`
 *   7. the buffering trap (CLAUDE.md): rendered audio for the provider's own
 *      segmentation of a reply vs the same reply as one request, and the gap a
 *      listener would hear at each segment boundary when sent one at a time
 *
 * NOT covered, because each would need deliberate abuse of the account: the 429
 * at the concurrency limit, whether an aborted request frees its slot at once,
 * and the 3,000-character limit.
 *
 * Every request bills a few dozen characters (section 7: a few hundred).
 *
 *   npm run murf:http:probe
 *   MURF_HTTP_URL=https://us-east.api.murf.ai/v1/speech/stream npm run murf:http:probe
 */
import 'dotenv/config';
import { pcm16DurationMs, stripWavHeader } from '../src/audio/pcm.js';
import { segmentText } from '../src/providers/tts/MurfTtsProvider.js';

const KEY = process.env.MURF_API_KEY;
if (!KEY) {
  console.error('MURF_API_KEY is not set. Put it in backend/.env and re-run.');
  process.exit(1);
}

const IN = process.env.MURF_HTTP_URL || 'https://in.api.murf.ai/v1/speech/stream';
const GLOBAL = 'https://global.api.murf.ai/v1/speech/stream';
const TEXT = 'Our refund window is thirty days from the date of purchase.';
const VOICE = process.env.MURF_VOICE ?? 'en-US-natalie';
const RUNS = 3;

interface Result {
  status: number;
  ttfb?: number;
  total: number;
  bytes: number;
  /** When each body chunk arrived, ms from the request. */
  arrivals: number[];
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
    return { status: res.status, total: performance.now() - t0, bytes: 0, arrivals: [], audioMs: 0, riff: false, headers, error: await res.text() };
  }
  let ttfb: number | undefined;
  const chunks: Buffer[] = [];
  const arrivals: number[] = [];
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    const at = performance.now() - t0;
    ttfb ??= at;
    arrivals.push(at);
    chunks.push(Buffer.from(c));
  }
  const all = Buffer.concat(chunks);
  return {
    status: res.status,
    ttfb,
    total: performance.now() - t0,
    bytes: all.length,
    arrivals,
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

const rtf = (r: Result) => (r.ttfb !== undefined && r.audioMs ? (r.audioMs / (r.total - r.ttfb)).toFixed(1) : '-');

console.log(`Murf HTTP probe — ${new Date().toISOString()}\nvoice=${VOICE}  text=${JSON.stringify(TEXT)}\n`);

console.log("1-3. the provider's exact request, configured host (cold: first request to it)");
const first = await post(IN, body());
show(IN, first);

console.log(`\n4-5. TTFB: cold, then median of ${RUNS} warm. Delivery speed = audio ms per body ms (>1 is faster than real time)`);
const hosts = IN === GLOBAL ? [IN] : [IN, GLOBAL];
if (hosts.length === 1) console.log('  (MURF_HTTP_URL is the global host — nothing to compare it with)');
for (const url of hosts) {
  const cold = url === IN ? first : await post(url, body());
  show(`  ${new URL(url).host} cold`, cold);
  const rs: Result[] = [];
  for (let i = 0; i < RUNS; i++) rs.push(await post(url, body()));
  for (const [i, r] of rs.entries()) show(`  ${new URL(url).host} warm #${i + 1}`, r);
  const ok = rs.filter((r) => r.ttfb !== undefined);
  console.log(
    `  -> cold TTFB ${cold.ttfb?.toFixed(0) ?? '-'}ms · warm median ${ok.length ? median(ok.map((r) => r.ttfb!)).toFixed(0) : '-'}ms ` +
      `(${ok.length}/${RUNS}) · delivery speed ${ok.map(rtf).join(' / ')}x\n`,
  );
}

console.log('6. the older model spelling, and gen2 on this host');
show('model=falcon-2', await post(IN, body({ model: 'falcon-2' })));
show('model=gen2', await post(IN, body({ model: 'gen2' })));

console.log('\n7. the provider\'s segmentation vs one request, and the gap at each boundary');
const REPLY =
  'Thanks for waiting. Your refund of 3.5 dollars was approved by Dr. Rao this morning. ' +
  'It should reach your account within five working days. Is there anything else I can help with?';
// Word by word, as LLM tokens reach the provider, then flushed — its exact segmentation.
const segments: string[] = [];
let pending = '';
for (const word of REPLY.match(/\S+\s*/g)!) {
  const r = segmentText(pending + word, false);
  segments.push(...r.segments);
  pending = r.rest;
}
segments.push(...segmentText(pending, true).segments);
const oneShot = await post(IN, body({ text: REPLY }));
show('one request', oneShot);
// Sequential, exactly as the provider sends them: each starts when the previous response ends.
let clock = 0; // ms since the first request was sent
let playedTo = 0; // when the listener's playback of everything so far would end
let splitAudio = 0;
const gaps: number[] = [];
for (const [i, seg] of segments.entries()) {
  const r = await post(IN, body({ text: seg }));
  show(`segment ${i + 1}/${segments.length} (${seg.length} chars)`, r);
  if (r.ttfb === undefined) break;
  const startsAt = clock + r.ttfb;
  if (i > 0) gaps.push(Math.max(0, startsAt - playedTo));
  playedTo = Math.max(playedTo, startsAt) + r.audioMs;
  splitAudio += r.audioMs;
  clock += r.total;
}
console.log(
  `  -> ${segments.length} segments: ${splitAudio}ms of audio vs ${oneShot.audioMs}ms one-shot ` +
    `(${oneShot.audioMs ? ((splitAudio / oneShot.audioMs - 1) * 100).toFixed(0) : '-'}% extra)\n` +
    `  -> silence a listener would hear at each boundary: ${gaps.map((g) => `${g.toFixed(0)}ms`).join(', ') || 'n/a'} ` +
    '(0 = the next segment arrived before the previous one finished playing)',
);
