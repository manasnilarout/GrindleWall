/**
 * Verifies GeminiTtsProvider and GeminiSttProvider against local fakes — a tiny
 * HTTP server speaking Google's generateContent/SSE dialect, and a WebSocket
 * server speaking the Live API's bidi dialect. Needs no API key and no network.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT PROVE
 * ---------------------------------------------------------------------------
 * A fake written from the same reading of the docs as the provider will accept
 * anything the provider sends. Every check below is a check on OUR handling —
 * base64 decoding, rate parsing, header stripping, request routing, queueing,
 * turn boundaries, barge-in. **None of it is evidence that Google accepts any of
 * these requests**, and no number printed here is a latency measurement.
 *
 * At the time of writing neither provider had ever run against the live API (the
 * account returned HTTP 429, "prepayment credits are depleted"), so per this
 * repo's claim-discipline rule the vendor's behaviour remains doc-derived and
 * unverified. A green run here does not change that; only a live probe does.
 *
 *   npx tsx scripts/gemini-speech-selftest.ts
 */
import http from 'node:http';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { once } from 'node:events';
import { GeminiTtsProvider } from '../src/providers/tts/GeminiTtsProvider.js';
import { GeminiSttProvider } from '../src/providers/stt/GeminiSttProvider.js';
import { CANONICAL_SAMPLE_RATE } from '../src/shared/protocol.js';
import { languagesFor } from '../src/providers/catalog.js';
import { silence, tone } from '../src/audio/pcm.js';

const results: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => results.push([n, ok, d]);

const STREAMING_MODEL = 'gemini-3.1-flash-tts-preview';
const ONESHOT_MODEL = 'gemini-2.5-flash-preview-tts';

/* ------------------------------------------------------------------ *
 * Fake TTS endpoint
 * ------------------------------------------------------------------ */

interface TtsRequest {
  url: string;
  body: Record<string, any>;
  headers: http.IncomingHttpHeaders;
}

type TtsHandler = (res: http.ServerResponse, req: TtsRequest) => void;

const ttsRequests: TtsRequest[] = [];
let ttsHandler: TtsHandler = (res) => res.end('{}');

const httpServer = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c as Buffer));
  req.on('end', () => {
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      /* keep empty */
    }
    const entry: TtsRequest = { url: req.url ?? '', body, headers: req.headers };
    ttsRequests.push(entry);
    ttsHandler(res, entry);
  });
});
httpServer.listen(0);
await once(httpServer, 'listening');
const ttsBase = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}/v1beta/models`;

/** One GenerateContentResponse carrying a single audio part. */
const audioResponse = (pcm: Buffer, mimeType: string) => ({
  candidates: [{ content: { parts: [{ inlineData: { mimeType, data: pcm.toString('base64') } }] } }],
});

const sse = (res: http.ServerResponse, obj: unknown) => {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch {
    /* client aborted */
  }
};

const json = (res: http.ServerResponse, obj: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

const beginSse = (res: http.ServerResponse) => {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
};

const ttsCredentials = { GOOGLE_API_KEY: 'test-key', GEMINI_BASE_URL: ttsBase };
const tts = new GeminiTtsProvider();

interface TtsRunResult { bytes: number; chunks: number; errors: string[]; doneCalls: number }

async function runTts(
  texts: string[],
  opts: { model?: string; language?: string; voice?: string } = {},
): Promise<TtsRunResult> {
  ttsRequests.length = 0;
  const errors: string[] = [];
  let bytes = 0;
  let chunks = 0;
  let doneCalls = 0;

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const stream = await tts.open(
    {
      model: opts.model ?? STREAMING_MODEL,
      voice: opts.voice,
      language: opts.language,
      sampleRate: CANONICAL_SAMPLE_RATE,
      credentials: ttsCredentials,
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

  for (const t of texts) stream.pushText(t);
  stream.flush();
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  stream.close();
  return { bytes, chunks, errors, doneCalls };
}

/* 1. happy path over the streaming model: SSE frames decode and end the turn */
const speech = tone(200); // 200ms @ 24kHz = 9600 bytes
ttsHandler = (res) => {
  beginSse(res);
  sse(res, audioResponse(speech, 'audio/L16;codec=pcm;rate=24000'));
  res.end();
};
let r = await runTts(['Hello ', 'world']);
check('decodes base64 audio', r.bytes === speech.length, `${r.bytes} of ${speech.length} bytes`);
check('emits ~40ms frames, not one buffer', r.chunks === 5, `${r.chunks} chunks`);
check('onDone fired exactly once', r.doneCalls === 1, `${r.doneCalls}`);
check('no errors on happy path', r.errors.length === 0, r.errors.join('; '));

/* 2. request shape and routing */
check('one request for the whole turn', ttsRequests.length === 1, `${ttsRequests.length}`);
const first = ttsRequests[0];
check('text pushed before flush is sent as one body',
  first?.body?.contents?.[0]?.parts?.[0]?.text === 'Hello world',
  JSON.stringify(first?.body?.contents));
check('api key sent as x-goog-api-key header', first?.headers['x-goog-api-key'] === 'test-key');
check('api key absent from the URL', !first?.url.includes('test-key'), first?.url);
check('streaming model posts to :streamGenerateContent?alt=sse',
  first?.url.includes(`${STREAMING_MODEL}:streamGenerateContent`) && first.url.includes('alt=sse'),
  first?.url);
check('AUDIO requested as the response modality',
  JSON.stringify(first?.body?.generationConfig?.responseModalities) === '["AUDIO"]',
  JSON.stringify(first?.body?.generationConfig));
check('default voice is Kore',
  first?.body?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName === 'Kore',
  JSON.stringify(first?.body?.generationConfig?.speechConfig));
check('multiSpeakerVoiceConfig not sent alongside voiceConfig',
  !('multiSpeakerVoiceConfig' in (first?.body?.generationConfig?.speechConfig ?? {})));

/* 3. multiple SSE frames stream out as they arrive */
ttsHandler = (res) => {
  beginSse(res);
  for (let i = 0; i < 3; i++) sse(res, audioResponse(speech, 'audio/L16;codec=pcm;rate=24000'));
  res.end();
};
r = await runTts(['x']);
check('every SSE audio part is emitted', r.bytes === speech.length * 3, `${r.bytes} bytes`);

/* 4. the one-shot models take the plain verb */
ttsHandler = (res) => json(res, audioResponse(speech, 'audio/L16;codec=pcm;rate=24000'));
r = await runTts(['x'], { model: ONESHOT_MODEL });
check('non-streaming model posts to :generateContent',
  ttsRequests[0]?.url.includes(`${ONESHOT_MODEL}:generateContent`) &&
    !ttsRequests[0].url.includes('alt=sse'),
  ttsRequests[0]?.url);
check('one-shot response decodes', r.bytes === speech.length, `${r.bytes} bytes`);
check('one-shot path fires onDone once', r.doneCalls === 1, `${r.doneCalls}`);

/* 5. the sample rate is READ from mimeType, never assumed.
   16 kHz in must come back out at the 24 kHz session boundary. */
const at16k = tone(200, 220, 16000); // 3200 samples = 6400 bytes
ttsHandler = (res) => json(res, audioResponse(at16k, 'audio/L16;codec=pcm;rate=16000'));
r = await runTts(['x'], { model: ONESHOT_MODEL });
check('mimeType rate=16000 is resampled up to 24000',
  r.bytes === Math.floor((at16k.length / 2) * 1.5) * 2,
  `${r.bytes} bytes from ${at16k.length}`);

ttsHandler = (res) => json(res, audioResponse(speech, 'audio/L16;codec=pcm'));
r = await runTts(['x'], { model: ONESHOT_MODEL });
check('mimeType with no rate= falls back to 24000 unchanged', r.bytes === speech.length, `${r.bytes} bytes`);

/* 6. a WAV-headered payload is still usable (docs say headerless; belt and braces) */
const wav = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'),
  Buffer.from('fmt '), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(16); return b; })(), Buffer.alloc(16),
  Buffer.from('data'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(400); return b; })(), speech.subarray(0, 400),
]);
ttsHandler = (res) => json(res, audioResponse(wav, 'audio/L16;codec=pcm;rate=24000'));
r = await runTts(['x'], { model: ONESHOT_MODEL });
check('strips a RIFF header from the payload', r.bytes === 400, `${r.bytes} bytes`);

/* 7. languageCode: only the 30 locales SpeechConfig enumerates, never a bare code */
ttsHandler = (res) => json(res, audioResponse(speech, 'audio/L16;codec=pcm;rate=24000'));
await runTts(['x'], { model: ONESHOT_MODEL, language: 'en-US' });
check('languageCode forwarded for the listed locale en-US',
  ttsRequests[0]?.body?.generationConfig?.speechConfig?.languageCode === 'en-US',
  JSON.stringify(ttsRequests[0]?.body?.generationConfig?.speechConfig));

await runTts(['x'], { model: ONESHOT_MODEL, language: 'en' });
check('bare en is DROPPED, not forwarded',
  !('languageCode' in (ttsRequests[0]?.body?.generationConfig?.speechConfig ?? {})),
  JSON.stringify(ttsRequests[0]?.body?.generationConfig?.speechConfig));

await runTts(['x'], { model: ONESHOT_MODEL, language: 'en-CA' });
check('an unlisted locale is DROPPED too',
  !('languageCode' in (ttsRequests[0]?.body?.generationConfig?.speechConfig ?? {})),
  JSON.stringify(ttsRequests[0]?.body?.generationConfig?.speechConfig));

/* 8. errors surface with Google's message, and still close the turn */
ttsHandler = (res) =>
  json(res, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'no such voice: Nope' } }, 400);
r = await runTts(['x'], { model: ONESHOT_MODEL, voice: 'Nope' });
check('surfaces the API error message', r.errors.some((e) => e.includes('no such voice')), r.errors.join('; '));
check('closes the turn after an error', r.doneCalls === 1, `${r.doneCalls}`);

/* 8b. an error inside a 200 SSE frame is surfaced the same way */
ttsHandler = (res) => {
  beginSse(res);
  sse(res, { error: { message: 'PROHIBITED_CONTENT' } });
  res.end();
};
r = await runTts(['x']);
check('surfaces an error carried inside an SSE frame',
  r.errors.some((e) => e.includes('PROHIBITED_CONTENT')), r.errors.join('; '));
check('SSE error still fires onDone once', r.doneCalls === 1, `${r.doneCalls}`);

/* 9. barge-in: cancel must abort the in-flight request immediately */
ttsHandler = (res) => {
  beginSse(res);
  const t = setInterval(() => sse(res, audioResponse(speech, 'audio/L16;codec=pcm;rate=24000')), 20);
  const stop = () => clearInterval(t);
  res.on('close', stop);
  setTimeout(() => { stop(); try { res.end(); } catch { /* gone */ } }, 2000);
};
{
  let after = 0;
  let errs = 0;
  let dones = 0;
  const stream = await tts.open(
    { model: STREAMING_MODEL, sampleRate: CANONICAL_SAMPLE_RATE, credentials: ttsCredentials },
    { onAudio: () => (after += 1), onDone: () => (dones += 1), onError: () => (errs += 1) },
  );
  stream.pushText('hello');
  stream.flush();
  await new Promise((res) => setTimeout(res, 250));
  const seen = after;
  stream.cancel();
  await new Promise((res) => setTimeout(res, 400));
  check('cancel stops audio immediately', after === seen && seen > 0, `${seen} -> ${after}`);
  check('cancel raises no error', errs === 0);
  check('cancel does not fire onDone (the turn is abandoned)', dones === 0, `${dones}`);
}

/* 10. an empty turn is closed out rather than posted */
ttsHandler = (res) => json(res, audioResponse(speech, 'audio/L16;codec=pcm;rate=24000'));
r = await runTts(['   ']);
check('empty text sends no request', ttsRequests.length === 0, `${ttsRequests.length}`);
check('empty text still fires onDone once', r.doneCalls === 1, `${r.doneCalls}`);

/* ------------------------------------------------------------------ *
 * Fake Live API socket
 * ------------------------------------------------------------------ */

type SttHandler = (send: (o: unknown) => void, msg: Record<string, any>) => void;

const sttReceived: Array<Record<string, any>> = [];
let sttUrl = '';
let sttHandler: SttHandler = () => {};
/** The live server socket, for scripting a turn the SERVER calls unprompted. */
let sttSocket: ServerSocket | undefined;

const wss = new WebSocketServer({ port: 0 });
wss.on('connection', (ws, req) => {
  sttSocket = ws;
  sttUrl = req.url ?? '';
  ws.on('message', (raw) => {
    let msg: Record<string, any> = {};
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      /* keep empty */
    }
    sttReceived.push(msg);
    sttHandler((o) => ws.send(JSON.stringify(o)), msg);
  });
});
await once(wss, 'listening');
const wsBase = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/ws/BidiGenerateContent`;

/** Server -> client, unprompted by anything the provider sent. */
const sttPush = (event: unknown) => sttSocket?.send(JSON.stringify(event));

const stt = new GeminiSttProvider();
const sttCredentials = { GOOGLE_API_KEY: 'test-key', GEMINI_WS_BASE: wsBase };

/** Default fake: ack setup, then finalize in fragments when asked to. */
const FRAGMENTS = ['Our refund ', 'window is ', 'thirty days.'];
sttHandler = (send, msg) => {
  if (msg.setup) {
    send({ setupComplete: {} });
    return;
  }
  if (msg.realtimeInput?.audioStreamEnd) {
    send({ serverContent: { interimInputTranscription: { text: 'Our ref' } } });
    for (const f of FRAGMENTS) send({ serverContent: { inputTranscription: { text: f } } });
    send({ serverContent: { turnComplete: true } });
  }
};

interface SttRunResult { partials: string[]; finals: string[]; speechEnds: number; errors: string[] }

async function runStt(
  opts: { language?: string; vad?: boolean } = {},
): Promise<SttRunResult> {
  sttReceived.length = 0;
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: string[] = [];
  let speechEnds = 0;

  let resolveFinal!: () => void;
  const gotFinal = new Promise<void>((res) => (resolveFinal = res));

  const stream = await stt.open(
    {
      model: 'gemini-3.5-transcribe-live',
      language: opts.language,
      sampleRate: CANONICAL_SAMPLE_RATE,
      credentials: sttCredentials,
      vad: opts.vad ?? false,
    },
    {
      onPartial: (t) => partials.push(t),
      onFinal: (t) => {
        finals.push(t);
        resolveFinal();
      },
      onSpeechEnd: () => (speechEnds += 1),
      onError: (e) => errors.push(e.message),
    },
  );

  // Synchronously, before the socket can possibly have handshaken — let alone
  // acked setup. This is the queueing path.
  stream.pushAudio(tone(100));
  await new Promise((res) => setTimeout(res, 150));
  stream.pushAudio(tone(100));
  stream.finalize();
  await Promise.race([gotFinal, new Promise((res) => setTimeout(res, 3000))]);
  stream.close();
  return { partials, finals, speechEnds, errors };
}

let s = await runStt({ language: 'en-US' });
check('STT key travels as a query param', sttUrl.includes('key=test-key'), sttUrl);
const setup = sttReceived.find((m) => m.setup)?.setup;
check('setup is the first message', sttReceived[0]?.setup !== undefined);
check('model carries the models/ prefix',
  setup?.model === 'models/gemini-3.5-transcribe-live', JSON.stringify(setup?.model));
check('inputAudioTranscription is top-level on setup, not in generationConfig',
  setup?.inputAudioTranscription !== undefined &&
    !('inputAudioTranscription' in (setup?.generationConfig ?? {})),
  JSON.stringify(setup));
check('responseModalities is TEXT',
  JSON.stringify(setup?.generationConfig?.responseModalities) === '["TEXT"]');
check('locale forwarded as languageCodes',
  JSON.stringify(setup?.inputAudioTranscription?.languageCodes) === '["en-US"]',
  JSON.stringify(setup?.inputAudioTranscription));

const audioMsgs = sttReceived.filter((m) => m.realtimeInput?.audio);
check('audio pushed before setupComplete is queued, not lost',
  audioMsgs.length === 2, `${audioMsgs.length} audio messages`);
check('audio goes up base64-encoded',
  typeof audioMsgs[0]?.realtimeInput?.audio?.data === 'string' &&
    Buffer.from(audioMsgs[0].realtimeInput.audio.data, 'base64').length > 0);
check('mimeType declares the rate the bytes are actually at',
  audioMsgs[0]?.realtimeInput?.audio?.mimeType === 'audio/pcm;rate=16000',
  audioMsgs[0]?.realtimeInput?.audio?.mimeType);
{
  // 100ms of 24kHz PCM16 resampled to 16kHz = 1600 samples = 3200 bytes.
  const sent = Buffer.from(audioMsgs[0].realtimeInput.audio.data, 'base64').length;
  check('24kHz session audio is resampled to the declared 16kHz', sent === 3200, `${sent} bytes`);
}

check('finalize sends realtimeInput.audioStreamEnd',
  sttReceived.some((m) => m.realtimeInput?.audioStreamEnd === true));
check('onSpeechEnd fires once per turn', s.speechEnds === 1, `${s.speechEnds}`);
check('ONE final per utterance, not one per fragment', s.finals.length === 1, `${s.finals.length}`);
check('the final is every fragment concatenated',
  s.finals[0] === 'Our refund window is thirty days.', s.finals[0]);
check('fragments are surfaced as partials while they land',
  s.partials.length >= FRAGMENTS.length, `${s.partials.length}`);
check('no errors on the happy path', s.errors.length === 0, s.errors.join('; '));

/* Google's transcribe table is wider than <lang>-<REGION>: `ceb` carries no
   region at all and `es-419` a numeric one, so anything the catalog can offer
   has to be forwarded rather than silently dropped into auto-detect. */
const codesSent = () =>
  JSON.stringify(sttReceived.find((m) => m.setup)?.setup?.inputAudioTranscription?.languageCodes);

/* A bare TWO-letter tag is the ambiguous case and still falls through to
   auto-detect: `en-US` and `en-IN` are worlds apart on Indian English, and the
   catalog only ever offers the qualified forms. */
await runStt({ language: 'en' });
check('a bare two-letter tag drops to auto-detect', codesSent() === '[]', codesSent());

await runStt({ language: 'en-US' });
check('a qualified locale is forwarded', codesSent() === '["en-US"]', codesSent());

/* `ceb` is in Google's table with no region at all — it must reach the vendor. */
await runStt({ language: 'ceb' });
check('a bare three-letter locale is forwarded', codesSent() === '["ceb"]', codesSent());

await runStt({ language: 'es-419' });
check('a numeric M.49 region is forwarded', codesSent() === '["es-419"]', codesSent());

await runStt({ language: 'cmn-Hans-CN' });
check('a script+region locale is forwarded', codesSent() === '["cmn-Hans-CN"]', codesSent());

/* The catalog and the provider must not disagree about what is sendable. */
{
  const offered = languagesFor('gemini-stt', 'gemini-3.5-transcribe-live').map((l) => l.id);
  const dropped: string[] = [];
  for (const id of offered) {
    if (id === 'auto') continue;
    await runStt({ language: id });
    if (codesSent() !== JSON.stringify([id])) dropped.push(id);
  }
  check('every catalog locale reaches the vendor', dropped.length === 0, dropped.slice(0, 6).join(', '));
}

await runStt({ language: 'auto' });
check('only an explicit auto asks for auto-detect', codesSent() === '[]', codesSent());

/* the turn still closes if the server never sends turnComplete (the stall bug) */
sttHandler = (send, msg) => {
  if (msg.setup) return send({ setupComplete: {} });
  if (msg.realtimeInput?.audioStreamEnd) {
    for (const f of FRAGMENTS) send({ serverContent: { inputTranscription: { text: f } } });
    // deliberately no turnComplete
  }
};
s = await runStt();
check('a missing turnComplete does not strand the turn', s.finals.length === 1, `${s.finals.length}`);
check('the fallback final still carries the accumulated text',
  s.finals[0] === 'Our refund window is thirty days.', s.finals[0]);

/* ------------------------------------------------------------------ *
 * Gemini's OWN endpointing calls the turn
 * ------------------------------------------------------------------ *
 * Everything above finalizes from THIS side — `finalize()` sends
 * `audioStreamEnd` and the fake answers it. That is only one of the two ways a
 * turn ends. Gemini also endpoints on its own silence timer, and when it gets
 * there first `turnComplete` arrives with no `audioStreamEnd` ever having gone
 * up. Honouring only our own detector dropped that turn on the floor: no final,
 * the accumulated text left in place to be prepended to the NEXT utterance, and
 * the pipeline stalled until the 1.5s fallback — invented latency inside the
 * measured window. None of the fakes above ever produce that ordering.
 */
{
  // Acks setup and then says nothing unprompted. In particular it NEVER answers
  // `audioStreamEnd`, so a final can only come from the server-called path.
  sttHandler = (send, msg) => {
    if (msg.setup) send({ setupComplete: {} });
  };

  sttReceived.length = 0;
  const finals: Array<{ text: string; at: number }> = [];
  const errors: string[] = [];
  let speechEnds = 0;
  let notify: (() => void) | undefined;

  const stream = await stt.open(
    {
      model: 'gemini-3.5-transcribe-live',
      sampleRate: CANONICAL_SAMPLE_RATE,
      credentials: sttCredentials,
      // The local detector is off, so nothing on this side can call the turn.
      vad: false,
    },
    {
      onPartial: () => {},
      onFinal: (t) => {
        finals.push({ text: t, at: Date.now() });
        notify?.();
      },
      onSpeechEnd: () => (speechEnds += 1),
      onError: (e) => errors.push(e.message),
    },
  );

  /** Waits for the nth final, or gives up well past FINALIZE_FALLBACK_MS (1.5s). */
  const awaitFinal = async (n: number) => {
    if (finals.length >= n) return;
    await Promise.race([
      new Promise<void>((res) => (notify = res)),
      new Promise((res) => setTimeout(res, 2500)),
    ]);
    notify = undefined;
  };

  stream.pushAudio(tone(100));
  await new Promise((res) => setTimeout(res, 150)); // let setupComplete land

  /* utterance 1 — segments, then the server's own boundary */
  const t1 = Date.now();
  sttPush({ serverContent: { inputTranscription: { text: 'Our refund ' } } });
  sttPush({ serverContent: { inputTranscription: { text: 'window is thirty days.' } } });
  sttPush({ serverContent: { turnComplete: true } });
  await awaitFinal(1);

  check('a server-called turnComplete emits a final without any finalize() of ours',
    finals.length === 1, `${finals.length} finals`);
  check('the server-called final carries the whole utterance',
    finals[0]?.text === 'Our refund window is thirty days.', finals[0]?.text);
  check('nothing was sent up to ask for it (audioStreamEnd never went out)',
    !sttReceived.some((m) => m.realtimeInput?.audioStreamEnd === true),
    JSON.stringify(sttReceived.filter((m) => m.realtimeInput?.audioStreamEnd)));
  check('t0 is stamped when the server beats the local VAD',
    speechEnds === 1, `${speechEnds} onSpeechEnd calls`);
  check('the server-called final is prompt, not held for the 1.5s fallback',
    finals[0] !== undefined && finals[0].at - t1 < 400, `${(finals[0]?.at ?? Date.now()) - t1}ms`);

  /* utterance 2 on the SAME stream — the leak check */
  const t2 = Date.now();
  sttPush({ serverContent: { inputTranscription: { text: 'Right, ' } } });
  sttPush({ serverContent: { inputTranscription: { text: 'thanks.' } } });
  sttPush({ serverContent: { turnComplete: true } });
  await awaitFinal(2);

  check('a second server-called utterance gets its own final',
    finals.length === 2, `${finals.length} finals`);
  check('no text leaks from the first utterance into the second',
    finals[1]?.text === 'Right, thanks.', finals[1]?.text);
  check('the second final is prompt too',
    finals[1] !== undefined && finals[1].at - t2 < 400, `${(finals[1]?.at ?? Date.now()) - t2}ms`);
  check('t0 is stamped for the second turn as well', speechEnds === 2, `${speechEnds}`);

  /* a boundary with nothing behind it is not a boundary — the fix must not
     invent a turn out of a bare turnComplete between utterances */
  sttPush({ serverContent: { turnComplete: true } });
  await new Promise((res) => setTimeout(res, 150));
  check('a bare turnComplete between utterances emits no phantom final',
    finals.length === 2, `${finals.length} finals`);

  /* utterance 3 — this one WE call. It is where a dropped server-called turn
     actually shows up: its text was never cleared, so it rides along on the
     next final this side asks for, and the LLM leg is handed two turns
     concatenated. Checking the LAST final rather than an index makes the
     leaked string visible in the failure detail. */
  sttHandler = (send, msg) => {
    if (msg.setup) return send({ setupComplete: {} });
    if (msg.realtimeInput?.audioStreamEnd) send({ serverContent: { turnComplete: true } });
  };
  sttPush({ serverContent: { inputTranscription: { text: 'One more thing.' } } });
  await new Promise((res) => setTimeout(res, 60));
  stream.finalize();
  await awaitFinal(3);

  check('a locally-finalized turn carries only its own text',
    finals[finals.length - 1]?.text === 'One more thing.', finals[finals.length - 1]?.text);
  check('three utterances produce three finals, one each',
    finals.length === 3, `${finals.length} finals`);

  check('server-called turns raise no error', errors.length === 0, errors.join('; '));
  stream.close();
}

/* ------------------------------------------------------------------ *
 * The LOCAL detector calls the turn
 * ------------------------------------------------------------------ *
 * Gemini publishes no speech-end event, so `SpeechEndDetector` IS t0 for this
 * provider — the single most load-bearing number in the bench. Every scenario
 * above runs with `vad: false`, which leaves that branch completely
 * unexercised: delete the `opts.vad && vad.push(...) === 'end'` line and none
 * of them can tell. So this one feeds REAL samples — 400ms of tone past
 * `minSpeechMs` (250), then 700ms of true silence past `silenceMs` (600) — and
 * asserts the edge is detected here, with the vendor having said nothing.
 */
{
  // Acks setup and is then mute. In particular it never answers
  // `audioStreamEnd`, so any t0 seen below came from this side.
  sttHandler = (send, msg) => {
    if (msg.setup) send({ setupComplete: {} });
  };

  const speak = async (vad: boolean) => {
    sttReceived.length = 0;
    const errors: string[] = [];
    let speechEnds = 0;
    let speechEndAt = 0;
    const stream = await stt.open(
      {
        model: 'gemini-3.5-transcribe-live',
        sampleRate: CANONICAL_SAMPLE_RATE,
        credentials: sttCredentials,
        vad,
      },
      {
        onPartial: () => {},
        onFinal: () => {},
        onSpeechEnd: () => {
          speechEnds += 1;
          speechEndAt = Date.now();
        },
        onError: (e) => errors.push(e.message),
      },
    );
    await new Promise((res) => setTimeout(res, 150)); // let setupComplete land
    stream.pushAudio(tone(400));
    const stoppedAt = Date.now();
    stream.pushAudio(silence(700));
    await new Promise((res) => setTimeout(res, 80));
    const finalized = sttReceived.some((m) => m.realtimeInput?.audioStreamEnd === true);
    stream.close();
    return { errors, speechEnds, lag: speechEndAt - stoppedAt, finalized };
  };

  const on = await speak(true);
  check('the local detector calls the turn on the speech -> silence edge',
    on.speechEnds === 1, `${on.speechEnds} onSpeechEnd calls`);
  check('t0 is stamped at the silence, not at some vendor round trip',
    on.speechEnds === 1 && on.lag < 200,
    on.speechEnds === 1 ? `${on.lag}ms after the audio went in` : 'onSpeechEnd never fired');
  check('the local detector immediately asks the vendor to finalize',
    on.finalized, JSON.stringify(sttReceived.map((m) => Object.keys(m)[0])));
  check('the local detector raises no error', on.errors.length === 0, on.errors.join('; '));

  // The contrast: `vad: false` is the pipeline saying it will supply the
  // boundary itself, and this provider must then keep its hands off t0.
  const off = await speak(false);
  check('with the local detector off, the same audio ends no turn',
    off.speechEnds === 0, `${off.speechEnds} onSpeechEnd calls`);
  check('...and nothing is sent up to finalize it', !off.finalized);
}

/* server errors surface */
sttHandler = (send, msg) => {
  if (msg.setup) send({ error: { code: 400, message: 'Invalid JSON payload received.' } });
};
s = await runStt();
check('surfaces a server error message',
  s.errors.some((e) => e.includes('Invalid JSON payload')), s.errors.join('; '));

/* ------------------------------------------------------------------ *
 * An abnormal close mid-turn must not swallow the turn.
 *
 * Observed live (2026-09-05): a `gemini-tts -> gemini-stt` round trip closed
 * 1006 after six good partials. The transcript was banked in `segments` and
 * the socket died before any boundary arrived, so the provider reported an
 * error and emitted no final at all — which above this layer is not an error
 * but a HANG, the pipeline waiting forever on a final that will never come.
 * ------------------------------------------------------------------ */

sttHandler = (send, msg) => {
  if (msg.setup) {
    send({ setupComplete: {} });
    return;
  }
  if (msg.realtimeInput?.audioStreamEnd) {
    send({ serverContent: { inputTranscription: { text: 'Our refund window is thirty days.' } } });
    // ...and then the socket dies, with no turnComplete and no generationComplete.
    setTimeout(() => sttSocket?.close(1011, 'internal'), 20);
  }
};
s = await runStt();
check('an abnormal close emits the transcript banked so far',
  s.finals.length === 1 && s.finals[0] === 'Our refund window is thirty days.',
  JSON.stringify(s.finals));
check('...exactly once', s.finals.length === 1, `${s.finals.length} finals`);
check('...and still surfaces the close as an error',
  s.errors.some((e) => e.includes('1011')), s.errors.join('; '));

/* The mirror case: a turn that already finalized cleanly must not be billed a
 * second final just because the socket closed afterwards. */
sttHandler = (send, msg) => {
  if (msg.setup) {
    send({ setupComplete: {} });
    return;
  }
  if (msg.realtimeInput?.audioStreamEnd) {
    send({ serverContent: { inputTranscription: { text: 'Already done.' } } });
    send({ serverContent: { turnComplete: true } });
    setTimeout(() => sttSocket?.close(1011, 'internal'), 20);
  }
};
s = await runStt();
check('a close after a clean finalize emits no second final',
  s.finals.length === 1 && s.finals[0] === 'Already done.', JSON.stringify(s.finals));

let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  -> ${d}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
wss.close();
httpServer.close();
process.exit(failed ? 1 : 0);
