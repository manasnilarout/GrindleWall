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
import { languagesFor, voicesFor } from '../src/providers/catalog.js';
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

async function run(
  words: string[],
  opts: { voice?: string; language?: string; model?: string } = {},
): Promise<RunResult> {
  received.length = 0;
  const errors: string[] = [];
  let bytes = 0;
  let chunks = 0;
  let doneCalls = 0;

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const stream = await provider.open(
    {
      model: opts.model ?? 'falcon-2',
      voice: opts.voice,
      language: opts.language,
      sampleRate: CANONICAL_SAMPLE_RATE,
      credentials,
    },
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
check('catalog voice keeps the default style', vc2.style === 'Conversational', JSON.stringify(vc2));

/* 5b. a hand-typed voice id is sent as-is, and carries no assumed style */
await run(['hi '], { voice: '  ab12cd34-0000-4444-8888-ffffffffffff  ', language: 'en-US' });
const vc3 = (received[0]?.voice_config ?? {}) as Record<string, unknown>;
check('typed voice id trimmed and forwarded', vc3.voiceId === 'ab12cd34-0000-4444-8888-ffffffffffff', JSON.stringify(vc3));
check('no style assumed for a non-library voice id', !('style' in vc3), JSON.stringify(vc3));
check('locale still sent for a typed voice id', vc3.multi_native_locale === 'en-US');

/* 5c. the model picked in the UI is the model asked for on the wire */
await run(['hi '], { model: 'gen2' });
check('gen2 selection reaches the query string', lastUrl.includes('model=gen2'), lastUrl);
check('gen2 still asks for 24kHz PCM', lastUrl.includes('sample_rate=24000'), lastUrl);
const vc4 = (received[0]?.voice_config ?? {}) as Record<string, unknown>;
check('gen2 falls back to the default voice', vc4.voiceId === 'en-US-natalie', JSON.stringify(vc4));

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

/* 10. the catalog cannot offer one model the other model's voice.
   Murf rejects that outright — it is the error that sent us to the live API. */
const falconVoices = voicesFor('murf-tts', 'falcon-2');
const gen2Voices = voicesFor('murf-tts', 'gen2');
const falconIds = new Set(falconVoices.map((v) => v.id));
const gen2Ids = new Set(gen2Voices.map((v) => v.id));
check('falcon-2 has its own voice list', falconVoices.length > 100, `${falconVoices.length}`);
check('gen2 has its own voice list', gen2Voices.length > 100, `${gen2Voices.length}`);
check('the two lists genuinely differ',
  [...gen2Ids].some((id) => !falconIds.has(id)) && [...falconIds].some((id) => !gen2Ids.has(id)));
check('the provider default voice is valid on both models',
  falconIds.has('en-US-natalie') && gen2Ids.has('en-US-natalie'));
check('every catalog voice id is locale-prefixed (the docs\' bare names are not)',
  [...falconIds, ...gen2Ids].every((id) => /^[a-z]{2}-[a-z]{2,6}-/i.test(id)),
  [...falconIds, ...gen2Ids].filter((id) => !/^[a-z]{2}-[a-z]{2,6}-/i.test(id)).slice(0, 5).join(', '));
check('each model brings its own locales',
  languagesFor('murf-tts', 'falcon-2').length > 20 && languagesFor('murf-tts', 'gen2').length > 20);

let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  -> ${d}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
wss.close();
process.exit(failed ? 1 : 0);
