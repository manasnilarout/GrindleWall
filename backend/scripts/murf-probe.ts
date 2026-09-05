/**
 * Re-measures Murf's request shape and its text-buffering behaviour.
 *
 * The shape ambiguities are settled (2026-09-05): `api-key` header, `voiceId`,
 * `falcon-2`/`gen2` in the query string, and each model on its own host — Gen2
 * is refused by global.api.murf.ai. Stage 1 re-checks all of that rather than
 * trusting it, since the constants it feeds live in one table in the provider.
 * Stage 3 is the part that still matters day to day: it reports rendered audio
 * duration per buffering setting, which is how the Cartesia per-token trap was
 * caught.
 *
 *   npx tsx scripts/murf-probe.ts
 */
import 'dotenv/config';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { pcm16DurationMs, stripWavHeader } from '../src/audio/pcm.js';

const KEY = process.env.MURF_API_KEY;
if (!KEY) {
  console.error('MURF_API_KEY is not set. Put it in backend/.env and re-run.');
  process.exit(1);
}

const GLOBAL = 'wss://global.api.murf.ai/v1/speech/stream-input';
const US = 'wss://api.murf.ai/v1/speech/stream-input';
/** Falcon is only on the global host; Gen2 is only on the US one. */
const hostFor = (model: string) =>
  process.env.MURF_WS_BASE ?? (model.toLowerCase().startsWith('gen2') ? US : GLOBAL);
const TEXT = 'Our refund window is thirty days from the date of purchase.';
const SR = 24000;
const VOICE = process.env.MURF_VOICE ?? 'en-US-natalie';

interface Attempt {
  model: string;
  voiceKey: 'voiceId' | 'voice_id';
  auth: 'header' | 'query';
  format?: string;
  mode?: 'oneshot' | 'words';
  bufferDelay?: number | null;
}

interface Outcome { bytes: number; ttfb?: number; total?: number; err?: string }

function attempt(a: Attempt): Promise<Outcome> {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      model: a.model,
      sample_rate: String(SR),
      channel_type: 'MONO',
      format: a.format ?? 'PCM',
    });
    if (a.auth === 'query') params.set('api-key', KEY!);

    const ws = new WebSocket(`${hostFor(a.model)}?${params}`, {
      headers: a.auth === 'header' ? { 'api-key': KEY! } : {},
    });
    const ctx = randomUUID();
    let bytes = 0;
    let ttfb: number | undefined;
    let err: string | undefined;
    let t0 = 0;

    const finish = (o: Outcome) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(o);
    };
    const timer = setTimeout(() => finish({ bytes, ttfb, err: err ?? 'timeout' }), 30_000);

    ws.on('open', () => {
      t0 = performance.now();
      ws.send(
        JSON.stringify({
          voice_config: { [a.voiceKey]: VOICE, style: 'Conversational', rate: 0, pitch: 0, variation: 1 },
          context_id: ctx,
          ...(a.bufferDelay === undefined ? {} : a.bufferDelay === null ? {} : { max_buffer_delay_in_ms: a.bufferDelay }),
        }),
      );
      if (a.mode === 'words') {
        for (const w of TEXT.split(' ')) ws.send(JSON.stringify({ text: `${w} `, end: false, context_id: ctx }));
        ws.send(JSON.stringify({ text: '', end: true, context_id: ctx }));
      } else {
        ws.send(JSON.stringify({ text: TEXT, end: true, context_id: ctx }));
      }
    });

    ws.on('message', (raw) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m.error || m.errorCode || m.errorMessage) {
        err = JSON.stringify(m).slice(0, 150);
        return finish({ bytes, ttfb, err });
      }
      if (typeof m.audio === 'string' && m.audio) {
        ttfb ??= performance.now() - t0;
        bytes += stripWavHeader(Buffer.from(m.audio, 'base64')).length;
      }
      if (m.final) finish({ bytes, ttfb, total: performance.now() - t0 });
    });

    ws.on('error', (e) => finish({ bytes, ttfb, err: `socket: ${e.message}` }));
    ws.on('close', (code, reason) => {
      if (bytes > 0) return finish({ bytes, ttfb, total: performance.now() - t0 });
      finish({ bytes, ttfb, err: err ?? `closed ${code} ${reason.toString().slice(0, 80)}` });
    });
  });
}

const line = (label: string, o: Outcome) =>
  `${o.err ? 'FAIL' : 'ok  '} ${label.padEnd(46)} ttfb=${o.ttfb ? Math.round(o.ttfb) + 'ms' : '-'} ` +
  `audio=${o.bytes ? (pcm16DurationMs(o.bytes) / 1000).toFixed(2) + 's' : '-'}${o.err ? '  ' + o.err : ''}`;

console.log(`voice=${VOICE}  (override with MURF_VOICE=...)`);
console.log('voice ids are per model — npm run murf:voices lists them\n');
console.log('=== stage 1: auth / model / voice_config key ===');
let winner: Attempt | undefined;
for (const auth of ['header', 'query'] as const) {
  for (const model of ['falcon-2', 'FALCON', 'Falcon', 'gen2']) {
    for (const voiceKey of ['voiceId', 'voice_id'] as const) {
      const a: Attempt = { auth, model, voiceKey, mode: 'oneshot' };
      const o = await attempt(a);
      console.log(line(`auth=${auth} model=${model} key=${voiceKey}`, o));
      if (!o.err && o.bytes > 0 && !winner) winner = a;
    }
  }
}

if (!winner) {
  console.log('\nNo working combination. Check the key and MURF_VOICE, then re-run.');
  process.exit(1);
}

console.log(`\n=== stage 2: output format (using ${winner.auth}/${winner.model}/${winner.voiceKey}) ===`);
for (const format of ['PCM', 'WAV']) {
  console.log(line(`format=${format}`, await attempt({ ...winner, format })));
}

console.log('\n=== stage 3: text buffering (the Cartesia trap) ===');
console.log('reference — whole sentence in one message:');
console.log(line('oneshot', await attempt({ ...winner, mode: 'oneshot' })));
console.log('word-by-word, as the LLM leg actually streams:');
for (const bufferDelay of [0, 100, 250, null]) {
  const label = `words, max_buffer_delay_in_ms=${bufferDelay ?? 'default'}`;
  console.log(line(label, await attempt({ ...winner, mode: 'words', bufferDelay })));
}

console.log('\n--- MurfModelProfile in src/providers/tts/MurfTtsProvider.ts ---');
console.log(`  voiceKey   = '${winner.voiceKey}'`);
console.log(`  wireModel  = '${winner.model}'`);
console.log(`  wsBase     = '${hostFor(winner.model)}'`);
console.log(`  auth       = ${winner.auth}`);
console.log('\nPick the smallest buffer delay whose rendered audio matches the one-shot reference.');
process.exit(0);
