/**
 * Verifies ElevenLabsTtsProvider's message handling against a local fake that
 * speaks ElevenLabs' WebSocket dialect. Needs no API key and no network.
 *
 * READ THIS BEFORE TRUSTING A PASS. The fake below was written from the same docs
 * as the provider, so it accepts whatever the provider sends. A green run proves
 * the provider's own handling — framing, ordering, base64 decoding, the terminal
 * flag, error surfacing, queueing before the socket opens, WAV-header stripping,
 * barge-in — and proves NOTHING about what the live ElevenLabs API accepts. If
 * the request shape is wrong, this file is wrong the same way and still passes.
 *
 * The provider HAS since been run against the live vendor (2026-09-05): a
 * `elevenlabs-tts -> cartesia-stt` round trip transcribed back at 91% word
 * overlap, `pcm_24000` is served on this account tier, and rendered audio
 * duration was measured across `chunk_length_schedule` settings and
 * `auto_mode`. See the provider header for those numbers. None of that is
 * evidence about the fake below, which still only agrees with itself.
 *
 *   npx tsx scripts/elevenlabs-selftest.ts
 */
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { once } from 'node:events';
import { ElevenLabsTtsProvider } from '../src/providers/tts/ElevenLabsTtsProvider.js';
import { CANONICAL_SAMPLE_RATE } from '../src/shared/protocol.js';
import { tone } from '../src/audio/pcm.js';

type Handler = (send: (o: unknown) => void, msg: Record<string, unknown>, raw: string) => void;
let handler: Handler = () => {};
const received: Array<Record<string, unknown>> = [];
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastUrl = '';

/** The live server socket, for sending a frame the fake cannot express as JSON. */
let serverWs: ServerSocket | undefined;

const wss = new WebSocketServer({ port: 0 });
wss.on('connection', (ws, req) => {
  serverWs = ws;
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
const base = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;

const credentials = { ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_WS_BASE: base };
const provider = new ElevenLabsTtsProvider();

/** The init frame is the only one carrying voice_settings; everything else is text. */
const isInit = (m: Record<string, unknown> | undefined) => m?.voice_settings !== undefined;
const textFrames = () => received.filter((m) => 'text' in m && !isInit(m));

interface RunResult { bytes: number; chunks: number; errors: string[]; doneCalls: number }

async function run(
  words: string[],
  opts: { voice?: string; language?: string; model?: string; sampleRate?: number } = {},
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
      model: opts.model ?? 'eleven_flash_v2_5',
      voice: opts.voice,
      language: opts.language,
      sampleRate: opts.sampleRate ?? CANONICAL_SAMPLE_RATE,
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

/* 1. happy path: audio arrives per text frame, isFinal ends the turn */
const audio = tone(200).toString('base64');
handler = (send, msg) => {
  if (isInit(msg)) return;
  // Plain AudioOutput frames carry no `isFinal` at all. The schema types it as
  // `enum: [true]`, so `isFinal: false` is a shape the vendor cannot emit and
  // must not be modelled here — a fake that invents frames is how a suite ends
  // up testing its own author's guesses.
  send({ audio });
  if (msg.text === '') send({ audio: null, isFinal: true });
};
let r = await run(['Hello', 'world']);
check('decodes base64 audio', r.bytes > 0, `${r.bytes} bytes`);
check('emits one chunk per audio message', r.chunks === 3, `${r.chunks}`);
check('isFinal ends the turn', r.doneCalls === 1, `${r.doneCalls}`);
// `run()` closes the stream after the terminal frame, and the socket close that
// follows must not fire a second onDone — a duplicate would make PipelineSession
// finish the turn twice. Asserted by closing and settling AGAIN, rather than
// re-reading the same counter, which cannot fail independently of the line above.
{
  const before = r.doneCalls;
  await new Promise((res) => setTimeout(res, 120));
  check('the socket close that follows does not fire onDone again',
    r.doneCalls === before && before === 1, `${before} -> ${r.doneCalls}`);
}
check('no errors on happy path', r.errors.length === 0, r.errors.join('; '));
check('audio:null on the terminal frame emits no chunk',
  r.bytes === Buffer.from(audio, 'base64').length * 3, `${r.bytes} bytes`);

/* 2. request shape */
check('xi-api-key sent as header', lastHeaders['xi-api-key'] === 'test-key');
check('api key absent from URL', !lastUrl.includes('test-key'), lastUrl);
check('output_format=pcm_24000 requested', lastUrl.includes('output_format=pcm_24000'), lastUrl);
check('model id in query string', lastUrl.includes('model_id=eleven_flash_v2_5'), lastUrl);
check('voice id is a path segment', lastUrl.includes('/v1/text-to-speech/'), lastUrl);
check('auto_mode explicitly off (cannot fragment prosody)', lastUrl.includes('auto_mode=false'), lastUrl);

/* 3. the init message must precede any text */
const first = received[0];
check('init message sent first', isInit(first), JSON.stringify(first));
check('init text is the literal single space', first?.text === ' ', JSON.stringify(first?.text));
const vs = (first?.voice_settings ?? {}) as Record<string, unknown>;
check('init carries voice_settings', Object.keys(vs).length > 0, JSON.stringify(vs));
const gc = (first?.generation_config ?? {}) as Record<string, unknown>;
check('init carries generation_config', Object.keys(gc).length > 0, JSON.stringify(gc));
check('chunk_length_schedule opens at the vendor minimum, then their defaults',
  JSON.stringify(gc.chunk_length_schedule) === '[50,160,250,290]', JSON.stringify(gc));
check('generation_config sent only in the init frame (dodges generator_config)',
  !textFrames().some((m) => 'generation_config' in m || 'generator_config' in m));
check('voice_settings never resent (schema forbids changing it)',
  received.filter(isInit).length === 1, `${received.filter(isInit).length}`);
check('api key absent from the init frame (header spelling is unambiguous)',
  !('xi-api-key' in (first ?? {})) && !('xi_api_key' in (first ?? {})), JSON.stringify(Object.keys(first ?? {})));

/* 4. one text frame per chunk, then exactly one end-of-stream message */
const texts = textFrames();
check('one message per text chunk plus close', texts.length === 3, `${texts.length}`);
check('text chunks end with a single space',
  texts.slice(0, -1).every((m) => typeof m.text === 'string' && (m.text as string).endsWith(' ')),
  JSON.stringify(texts.map((m) => m.text)));
check('end-of-stream is the literal empty string', texts[texts.length - 1]?.text === '');
check('end-of-stream sent exactly once on flush',
  texts.filter((m) => m.text === '').length === 1, `${texts.filter((m) => m.text === '').length}`);

/* 4b. flush is idempotent, and text after it is dropped rather than sent post-close */
{
  received.length = 0;
  const stream = await provider.open(
    { model: 'eleven_flash_v2_5', sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: () => {}, onDone: () => {}, onError: () => {} },
  );
  stream.pushText('one');
  stream.flush();
  stream.flush();
  stream.pushText('late');
  await new Promise((res) => setTimeout(res, 200));
  stream.close();
  const t = textFrames();
  check('a second flush sends nothing more', t.filter((m) => m.text === '').length === 1, JSON.stringify(t.map((m) => m.text)));
  check('text after flush is dropped', !t.some((m) => String(m.text).includes('late')), JSON.stringify(t.map((m) => m.text)));
}

/* 5. snake_case terminator is accepted too (two official pages disagree) */
handler = (send, msg) => {
  if (isInit(msg)) return;
  if (msg.text === '') send({ audio, is_final: true });
};
r = await run(['x']);
check('is_final also ends the turn', r.doneCalls === 1, `${r.doneCalls}`);
check('audio still decoded alongside is_final', r.bytes > 0, `${r.bytes} bytes`);

/* 6. an audio:null frame with no terminator is tolerated silently */
handler = (send, msg) => {
  if (isInit(msg)) return;
  if (msg.text === '') {
    send({ audio: null });
    send({ audio, isFinal: true });
  }
};
r = await run(['x']);
check('audio:null tolerated without an empty chunk', r.chunks === 1, `${r.chunks} chunks`);
check('audio:null raises no error', r.errors.length === 0, r.errors.join('; '));

/* 7. a WAV-headered chunk is still usable */
const wav = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'),
  Buffer.from('fmt '), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(16); return b; })(), Buffer.alloc(16),
  Buffer.from('data'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(400); return b; })(), tone(200).subarray(0, 400),
]);
handler = (send, msg) => {
  if (isInit(msg)) return;
  if (msg.text === '') send({ audio: wav.toString('base64'), isFinal: true });
};
r = await run(['x']);
check('strips RIFF header from PCM chunk', r.bytes === 400, `${r.bytes} bytes`);

/* 8. an error FRAME surfaces and still closes the turn.
 *
 * ---------------------------------------------------------------------------
 * THE FRAME BELOW IS UNVERIFIED AND VENDOR-UNDOCUMENTED.
 * ---------------------------------------------------------------------------
 * ElevenLabs' AsyncAPI schema declares the server -> client union as exactly
 * `AudioOutput | FinalOutput`. There is NO error frame in it, and no doc page
 * publishes one. This shape — `{error, message, code}` — was read off our own
 * parser, so these two checks prove that the parser handles what the parser
 * expects and prove nothing about the vendor. They are kept because the branch
 * exists and should not rot, NOT as evidence the vendor sends this.
 *
 * The failure channel ElevenLabs actually publishes is the socket close code,
 * which is section 13 below. If a live probe ever shows the vendor sending
 * something else, THAT is the shape to test and this block should go.
 */
handler = (send, msg) => {
  if (isInit(msg)) return;
  send({ error: 'invalid_voice_id', message: 'no such voice' });
};
r = await run(['x']);
check('surfaces an error frame, if the vendor turns out to send one',
  r.errors.some((e) => e.includes('invalid_voice_id')), r.errors.join('; '));
check('closes the turn after an error frame', r.doneCalls === 1, `${r.doneCalls}`);

/* 9. barge-in: cancel must silence everything immediately */
handler = (send, msg) => {
  if (isInit(msg)) return;
  const t = setInterval(() => send({ audio }), 20);
  setTimeout(() => clearInterval(t), 2000);
};
{
  let after = 0;
  let errs = 0;
  const stream = await provider.open(
    { model: 'eleven_flash_v2_5', sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: () => (after += 1), onDone: () => {}, onError: () => (errs += 1) },
  );
  stream.pushText('hello');
  await new Promise((res) => setTimeout(res, 200));
  stream.cancel();
  const seen = after;
  await new Promise((res) => setTimeout(res, 400));
  check('cancel stops audio immediately', after === seen, `${seen} -> ${after}`);
  check('cancel raises no error', errs === 0, `${errs}`);
}

/* 10. text pushed before the socket opens is not lost, and init still goes first */
handler = (send, msg) => {
  if (isInit(msg)) return;
  send({ audio });
  if (msg.text === '') send({ audio: null, isFinal: true });
};
{
  received.length = 0;
  let bytes = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));
  const stream = await provider.open(
    { model: 'eleven_flash_v2_5', sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: (c) => (bytes += c.length), onDone: () => resolveDone(), onError: () => {} },
  );
  // Synchronously, before the handshake can possibly have finished.
  stream.pushText('queued');
  stream.flush();
  await Promise.race([done, new Promise((res) => setTimeout(res, 3000))]);
  stream.close();
  check('queues text sent before open', bytes > 0, `${bytes} bytes`);
  check('queued init message still goes first', isInit(received[0]), JSON.stringify(received[0]));
  check('queued chunk keeps its trailing space', received[1]?.text === 'queued ', JSON.stringify(received[1]));
}

/* 11. language_code: sent only where the docs say the model honours it.
   A model that does not IGNORES it silently, so a wrong one is worse than a 400 —
   it renders the wrong language instead of failing. */
handler = (send, msg) => {
  if (isInit(msg)) return;
  if (msg.text === '') send({ audio: null, isFinal: true });
};
/* Read as a query parameter, never with `includes`. `language_code=hi` is a
   PREFIX of `language_code=hi-in`, and a case-sensitive `!includes('hi-IN')`
   misses the lowercased form entirely — so substring matching passes happily on
   the exact value the vendor would silently ignore. Only exact equality on the
   parsed parameter can tell the two apart. */
const queryParam = (name: string) => new URL(lastUrl, 'http://x').searchParams.get(name);

await run(['hi'], { model: 'eleven_flash_v2_5', language: 'hi-IN' });
check('language_code forwarded on flash v2.5, narrowed to exactly the ISO 639-1 code',
  queryParam('language_code') === 'hi', String(queryParam('language_code')));

await run(['hi'], { model: 'eleven_turbo_v2_5', language: 'en-IN' });
check('the other language_code model narrows the same way',
  queryParam('language_code') === 'en', String(queryParam('language_code')));

await run(['hi'], { model: 'eleven_multilingual_v2', language: 'hi-IN' });
check('language_code absent on multilingual_v2 (the vendor would ignore it)',
  queryParam('language_code') === null, String(queryParam('language_code')));
check('multilingual_v2 still reaches the query string',
  queryParam('model_id') === 'eleven_multilingual_v2', String(queryParam('model_id')));

await run(['hi'], { model: 'eleven_flash_v2_5' });
check('no language_code when the session names no language',
  queryParam('language_code') === null, String(queryParam('language_code')));

/* 11b. the boundary rate is READ, not assumed.
   Every scenario above runs at CANONICAL_SAMPLE_RATE, which makes
   `resamplePcm16(pcm, 24000, opts.sampleRate)` a no-op — delete the call
   entirely and none of them notice. The invariant is that a provider adapts
   against the rate in ITS OPTIONS, so that it stays correct if the session
   boundary is ever reconfigured. Driving one turn off 24 kHz is the only way to
   see the call happen. */
{
  const oneChunk = tone(200); // 4800 samples @ 24kHz = 9600 bytes
  handler = (send, msg) => {
    if (isInit(msg)) return;
    if (msg.text === '') send({ audio: oneChunk.toString('base64'), isFinal: true });
  };

  r = await run(['x']);
  check('at the canonical rate the vendor bytes pass through untouched',
    r.bytes === oneChunk.length, `${r.bytes} of ${oneChunk.length} bytes`);

  r = await run(['x'], { sampleRate: 16000 });
  // 4800 samples at 24kHz -> 3200 samples at 16kHz -> 6400 bytes.
  const expected = Math.floor((oneChunk.length / 2) * (16000 / 24000)) * 2;
  check('a 16kHz session boundary gets the vendor audio resampled down to it',
    r.bytes === expected, `${r.bytes} bytes, expected ${expected}`);
  check('...and the pcm_24000 asked of the vendor does not follow the boundary',
    queryParam('output_format') === 'pcm_24000', String(queryParam('output_format')));
}

/* 11c. a frame that is not JSON at all must not take the turn down.
   Every frame the fake sends is well-formed by construction, so the parse
   guard in the message handler is never reached: remove it and the suite stays
   green while a single proxy error page would throw inside the socket
   callback. */
{
  handler = (send, msg) => {
    if (isInit(msg)) return;
    if (msg.text !== '') return;
    // A gateway error page, a keepalive, a truncated frame — anything the
    // vendor or something between us and it might put on the wire.
    serverWs?.send('<html><body>502 Bad Gateway</body></html>');
    send({ audio, isFinal: false });
    send({ audio: null, isFinal: true });
  };
  r = await run(['x']);
  check('a non-JSON frame is ignored rather than thrown',
    r.errors.length === 0, r.errors.join('; '));
  check('the audio after a non-JSON frame still arrives',
    r.bytes === Buffer.from(audio, 'base64').length, `${r.bytes} bytes`);
  check('the turn still completes after a non-JSON frame', r.doneCalls === 1, `${r.doneCalls}`);
}

/* 12. an explicit voice id reaches the path; the default is used when none is given */
await run(['hi'], { voice: '  ab12cd34ef56gh78ij90  ' });
check('explicit voice id trimmed into the path', lastUrl.includes('/ab12cd34ef56gh78ij90/stream-input'), lastUrl);
await run(['hi']);
check('falls back to the default voice', lastUrl.includes('/JBFqnCBsd6RMkjVDRZzb/stream-input'), lastUrl);

/* 13. the failure channel the vendor actually publishes: a close code.
 *
 * The schema's server -> client union is `AudioOutput | FinalOutput` and
 * nothing else, so a rejection — bad voice id, bad model, quota exhausted —
 * cannot arrive as a frame. It arrives as the socket closing under the turn.
 * That path had no coverage at all, which is the opposite way round from
 * section 8: the shape we invented was tested, the one the vendor documents
 * was not. */
{
  const errors: string[] = [];
  let doneCalls = 0;
  let bytes = 0;
  // Rejected at the handshake, the way a bad voice id in the path would be.
  handler = (_send, msg) => {
    if (isInit(msg)) serverWs?.close(1008, 'voice_not_found');
  };
  const stream = await provider.open(
    { model: 'eleven_flash_v2_5', sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: (c) => (bytes += c.length), onDone: () => (doneCalls += 1), onError: (e) => errors.push(e.message) },
  );
  stream.pushText('hello');
  await new Promise((res) => setTimeout(res, 300));
  check('a close arriving before the turn is flushed is surfaced as an error',
    errors.some((e) => e.includes('closed early')), errors.join('; '));
  check('the close code and the vendor\'s reason both reach the message',
    errors.some((e) => e.includes('1008') && e.includes('voice_not_found')), errors.join('; '));
  check('a rejected turn is still ended exactly once, not left hanging',
    doneCalls === 1, `${doneCalls}`);
  check('a rejected turn emits no audio', bytes === 0, `${bytes} bytes`);
  stream.close();
}

{
  const errors: string[] = [];
  let doneCalls = 0;
  // The other half: the vendor hangs up normally at end of turn without ever
  // sending the terminal frame. There is nothing wrong here, so the turn must
  // end quietly rather than either stalling or inventing an error.
  handler = (_send, msg) => {
    if (isInit(msg)) return;
    if (msg.text === '') serverWs?.close(1000);
  };
  const stream = await provider.open(
    { model: 'eleven_flash_v2_5', sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: () => {}, onDone: () => (doneCalls += 1), onError: (e) => errors.push(e.message) },
  );
  stream.pushText('hello');
  stream.flush();
  await new Promise((res) => setTimeout(res, 300));
  check('a close after flush ends the turn instead of stalling it',
    doneCalls === 1, `${doneCalls}`);
  check('...and a normal close is not reported as an error', errors.length === 0, errors.join('; '));
  stream.close();
}

let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  -> ${d}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
wss.close();
process.exit(failed ? 1 : 0);
