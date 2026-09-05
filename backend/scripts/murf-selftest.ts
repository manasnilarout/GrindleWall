/**
 * Verifies MurfTtsProvider's message handling against a local fake that speaks
 * Murf's WebSocket dialect. Needs no API key and no network.
 *
 * This covers what a fake CAN prove — framing, base64 decoding, the `final`
 * flag, error surfacing, queueing before the socket opens, WAV-header stripping
 * and barge-in. It CANNOT prove Murf accepts our request shape; that is what
 * `npm run murf:probe` is for.
 *
 *   npx tsx scripts/murf-selftest.ts
 */
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { MurfTtsProvider } from '../src/providers/tts/MurfTtsProvider.js';
import { CANONICAL_SAMPLE_RATE } from '../src/shared/protocol.js';
import { tone } from '../src/audio/pcm.js';

type Handler = (send: (o: unknown) => void, msg: Record<string, unknown>, raw: string) => void;
let handler: Handler = () => {};
const received: Array<Record<string, unknown>> = [];
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastUrl = '';

const wss = new WebSocketServer({ port: 0 });
wss.on('connection', (ws, req) => {
  lastHeaders = req.headers;
  lastUrl = req.url ?? '';
  ws.on('message', (raw) => {
    const text = raw.toString();
    let msg: Record<string, unknown> = {};
    try {
      msg = JSON.parse(text);
    } catch {
      /* keep empty */
    }
    received.push(msg);
    handler((o) => ws.send(JSON.stringify(o)), msg, text);
  });
});
await once(wss, 'listening');
const base = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/v1/speech/stream-input`;

const credentials = { MURF_API_KEY: 'test-key', MURF_WS_BASE: base };
const provider = new MurfTtsProvider();

interface RunResult { bytes: number; chunks: number; errors: string[]; doneCalls: number }

async function run(words: string[], opts: { voice?: string; language?: string } = {}): Promise<RunResult> {
  received.length = 0;
  const errors: string[] = [];
  let bytes = 0;
  let chunks = 0;
  let doneCalls = 0;

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const stream = await provider.open(
    { model: 'falcon-2', voice: opts.voice, language: opts.language, sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    {
      onAudio: (c) => {
        chunks += 1;
        bytes += c.length;
      },
      onDone: () => {
        doneCalls += 1;
        resolveDone();
      },
      onError: (e) => errors.push(e.message),
    },
  );

  for (const w of words) stream.pushText(w);
  stream.flush();
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  stream.close();
  return { bytes, chunks, errors, doneCalls };
}

const results: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => results.push([n, ok, d]);

/* 1. happy path: audio arrives, final ends the turn */
const audio = tone(200).toString('base64');
handler = (send, msg) => {
  if (msg.voice_config) return;
  send({ audio, final: Boolean(msg.end) });
};
let r = await run(['Hello ', 'world ']);
check('decodes base64 audio', r.bytes > 0, `${r.bytes} bytes`);
check('emits one chunk per audio message', r.chunks === 3, `${r.chunks}`);
check('final:true ends the turn', r.doneCalls === 1, `${r.doneCalls}`);
check('no errors on happy path', r.errors.length === 0, r.errors.join('; '));

/* 2. request shape */
check('api-key sent as header', lastHeaders['api-key'] === 'test-key');
check('api key absent from URL', !lastUrl.includes('test-key'), lastUrl);
check('format=PCM requested', lastUrl.includes('format=PCM'), lastUrl);
check('sample_rate=24000 requested', lastUrl.includes('sample_rate=24000'), lastUrl);
check('channel_type=MONO requested', lastUrl.includes('channel_type=MONO'));
check('model in query string', lastUrl.includes('model=falcon-2'));

/* 3. voice_config must precede any text */
const first = received[0];
check('voice_config sent first', first?.voice_config !== undefined, JSON.stringify(first));
const vc = (first?.voice_config ?? {}) as Record<string, unknown>;
check('voice_config carries voiceId', 'voiceId' in vc, JSON.stringify(vc));
check('min_buffer_size set (avoids per-token fragmentation)', first?.min_buffer_size === 5, JSON.stringify(first));
check('buffer delay left at server default', !('max_buffer_delay_in_ms' in (first ?? {})));

/* 4. text messages: end flag only on the last one */
const texts = received.filter((m) => 'text' in m);
check('one message per text chunk plus close', texts.length === 3, `${texts.length}`);
check('end:false on interim chunks', texts.slice(0, -1).every((m) => m.end === false));
check('end:true on the final message', texts[texts.length - 1]?.end === true);
check('all messages share one context_id',
  new Set(received.map((m) => m.context_id)).size === 1);

/* 5. explicit voice + language pass through */
await run(['hi '], { voice: 'en-IN-aarav', language: 'en-IN' });
const vc2 = (received[0]?.voice_config ?? {}) as Record<string, unknown>;
check('explicit voice forwarded', vc2.voiceId === 'en-IN-aarav', JSON.stringify(vc2));
check('language forwarded as multi_native_locale', vc2.multi_native_locale === 'en-IN');

/* 6. a WAV-headered chunk is still usable */
const wav = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'),
  Buffer.from('fmt '), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(16); return b; })(), Buffer.alloc(16),
  Buffer.from('data'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(400); return b; })(), tone(200).subarray(0, 400),
]);
handler = (send, msg) => {
  if (msg.voice_config) return;
  if (msg.end) send({ audio: wav.toString('base64'), final: true });
};
r = await run(['x ']);
check('strips RIFF header from PCM chunk', r.bytes === 400, `${r.bytes} bytes`);

/* 7. error object surfaces and still closes the turn */
handler = (send, msg) => {
  if (msg.voice_config) return;
  send({ error: 'INVALID_VOICE: no such voice' });
};
r = await run(['x ']);
check('surfaces server error', r.errors.some((e) => e.includes('INVALID_VOICE')), r.errors.join('; '));
check('closes the turn after an error', r.doneCalls === 1, `${r.doneCalls}`);

/* 8. barge-in: cancel must silence everything immediately */
handler = (send, msg) => {
  if (msg.voice_config) return;
  const t = setInterval(() => send({ audio, final: false }), 20);
  setTimeout(() => clearInterval(t), 2000);
};
{
  let after = 0;
  let errs = 0;
  const stream = await provider.open(
    { model: 'falcon-2', sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: () => (after += 1), onDone: () => {}, onError: () => (errs += 1) },
  );
  stream.pushText('hello ');
  await new Promise((res) => setTimeout(res, 200));
  stream.cancel();
  const seen = after;
  await new Promise((res) => setTimeout(res, 400));
  check('cancel stops audio immediately', after === seen, `${seen} -> ${after}`);
  check('cancel raises no error', errs === 0);
}

/* 9. text pushed before the socket opens is not lost */
handler = (send, msg) => {
  if (msg.voice_config) return;
  send({ audio, final: Boolean(msg.end) });
};
{
  received.length = 0;
  let bytes = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));
  const stream = await provider.open(
    { model: 'falcon-2', sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: (c) => (bytes += c.length), onDone: () => resolveDone(), onError: () => {} },
  );
  // Synchronously, before the handshake can possibly have finished.
  stream.pushText('queued ');
  stream.flush();
  await Promise.race([done, new Promise((res) => setTimeout(res, 3000))]);
  stream.close();
  check('queues text sent before open', bytes > 0, `${bytes} bytes`);
  check('queued voice_config still goes first', received[0]?.voice_config !== undefined);
}

let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  -> ${d}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
wss.close();
process.exit(failed ? 1 : 0);
