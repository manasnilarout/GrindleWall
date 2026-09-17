/**
 * Verifies NovaSonicProvider's event handling against a local fake that speaks
 * Nova Sonic's event dialect. Needs no AWS key and no network.
 *
 * READ THIS BEFORE TRUSTING A PASS — and it matters more here than for any
 * other self-test in this repo.
 *
 * Elsewhere the fake at least speaks the same TRANSPORT as the vendor: Murf,
 * Cartesia and OpenAI Realtime are WebSockets, and their fakes are WebSocket
 * servers, so a fake exercises the real framing even though it accepts anything
 * sent to it. Nova Sonic is not a WebSocket. It is a SigV4-signed HTTP/2
 * bidirectional event stream through the AWS SDK, and nothing local can imitate
 * that. So this suite drives the provider through its `NovaTransport` seam with
 * a WebSocket standing in for the stream.
 *
 * What that means, precisely:
 *
 *   PROVED HERE — event ORDER and shape as this module builds them, the
 *   preamble, turn attribution by completionId, both barge-in signals, usage
 *   delta accumulation, the containment invariant, resampling against the
 *   session boundary, abandoned turns, and teardown order.
 *
 *   NOT PROVED HERE, AT ALL — that AWS accepts any of it. Not SigV4, not HTTP/2
 *   framing, not one field name, not the model id, not a voice id, not the
 *   input sample rate. The fake was written from the same doc pages as the
 *   provider, so the two agree with each other by construction and would agree
 *   just as happily if both were wrong.
 *
 * `npm run nova:probe` is the only check that can settle any of that, and as of
 * writing it has never been run — this repo has no AWS credentials. Nova Sonic
 * is therefore in the same doc-derived state the five late providers were in
 * before 2026-09-05, and should be described that way until a probe says
 * otherwise.
 *
 * ONE THING HAS BEEN ESTABLISHED LIVE (2026-09-17, three runs): driving this
 * provider through the real protocol with deliberately invalid AWS credentials
 * reaches Bedrock and comes back with the service's own
 * `UnrecognizedClientException` / HTTP 403, "The security token included in the
 * request is invalid." So the SDK path, SigV4 signing and HTTP/2 connection all
 * work, and `start()` rejects on a bad key. Authentication is checked before the
 * request body is, so that says nothing about the events below. The README
 * carries the command.
 *
 *   npx tsx scripts/nova-sonic-selftest.ts
 */
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { once } from 'node:events';
import { NovaSonicProvider } from '../src/providers/realtime/NovaSonicProvider.js';
import type { SessionEvents, VoiceSession } from '../src/providers/types.js';
import type { DerivedMetrics, LegUsage, MetricMark, StartConfig } from '../src/shared/protocol.js';
import { silence, tone } from '../src/audio/pcm.js';

/*
 * `pricing/rates.ts` resolves Nova's region from `process.env.AWS_REGION` ONCE,
 * at module load, so it is imported dynamically below rather than statically up
 * here — a static import would pin whatever region the shell happened to have
 * and make the pricing checks depend on the developer's environment.
 */
type PriceLeg = (leg: LegUsage) => LegUsage;
async function ratesFor(region: string): Promise<{ priceLeg: PriceLeg }> {
  process.env.AWS_REGION = region;
  // The query string busts Node's ESM cache so each region gets a fresh
  // evaluation; without it every call would return the first region's table.
  return (await import(`../src/pricing/rates.js?region=${encodeURIComponent(region)}`)) as { priceLeg: PriceLeg };
}

/* ------------------------------- the fake ------------------------------- */

type Json = Record<string, any>;

let serverWs: ServerSocket | undefined;
let received: Json[] = [];

const wss = new WebSocketServer({ port: 0 });
wss.on('connection', (ws) => {
  serverWs = ws;
  ws.on('message', (raw) => {
    try {
      received.push(JSON.parse(raw.toString()));
    } catch {
      received.push({});
    }
  });
});
await once(wss, 'listening');
const base = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;

/** Server -> client. `body` is what goes under the top-level `event` key. */
const push = (body: Json) => serverWs?.send(JSON.stringify({ event: body }));
const pushRaw = (frame: string) => serverWs?.send(frame);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- harness ------------------------------- */

interface Recorder {
  audio: Buffer[];
  user: Array<{ text: string; final: boolean; turnId: number }>;
  assistant: Array<{ text: string; final: boolean; turnId: number }>;
  turnStarts: number[];
  turnEnds: number[];
  interrupts: number;
  metrics: Array<{ turnId: number; marks: MetricMark[]; derived: DerivedMetrics }>;
  usage: Array<{ turnId: number; legs: LegUsage[] }>;
  logs: string[];
  errors: string[];
}

const provider = new NovaSonicProvider();

async function open(config: Partial<StartConfig> = {}): Promise<{ session: VoiceSession; rec: Recorder }> {
  received = [];
  resetUsage();
  const rec: Recorder = {
    audio: [], user: [], assistant: [], turnStarts: [], turnEnds: [], interrupts: 0,
    metrics: [], usage: [], logs: [], errors: [],
  };
  const events: SessionEvents = {
    onUserTranscript: (text, final, turnId) => rec.user.push({ text, final, turnId }),
    onAssistantTranscript: (text, final, turnId) => rec.assistant.push({ text, final, turnId }),
    onAudio: (chunk) => rec.audio.push(chunk),
    onTurnStart: (turnId) => rec.turnStarts.push(turnId),
    onTurnEnd: (turnId) => rec.turnEnds.push(turnId),
    onInterrupt: () => (rec.interrupts += 1),
    onMetrics: (turnId, marks, derived) => rec.metrics.push({ turnId, marks, derived }),
    onUsage: (turnId, legs) => rec.usage.push({ turnId, legs }),
    onLog: (level, message) => rec.logs.push(`${level}: ${message}`),
    onError: (err) => rec.errors.push(err.message),
  };

  const session = provider.createSession({
    sessionId: 'selftest',
    config: {
      mode: 'realtime',
      realtimeProviderId: 'aws-nova-sonic',
      realtimeModelId: 'amazon.nova-2-sonic-v1:0',
      systemPrompt: 'Speak clearly and briefly.',
      language: 'en-US',
      voice: 'tiffany',
      turnDetection: 'server_vad',
      ...config,
    },
    events,
    // Credentials only, and deliberately NO AWS keys: the fake transport must
    // be reachable without them, and the provider must never reach for
    // process.env (which in CI may well hold a real key).
    credentials: { NOVA_SONIC_WS_BASE: base },
  });
  await session.start();
  await settle(40);
  return { session, rec };
}

const sentOf = (name: string): Json[] =>
  received.filter((m) => m.event && Object.keys(m.event)[0] === name).map((m) => m.event[name]);
const order = (): string[] => received.map((m) => Object.keys(m.event ?? {})[0] ?? '?');
const audioBytes = (rec: Recorder) => rec.audio.reduce((n, b) => n + b.length, 0);

/** Speaks, then falls silent long enough for the local detector to end the turn. */
function speakThenPause(session: VoiceSession, rate = 24000): void {
  for (let i = 0; i < 6; i++) session.pushAudio(tone(60, 220, rate)); // 360ms of speech
  for (let i = 0; i < 12; i++) session.pushAudio(silence(60, rate)); // 720ms of silence
}

const results: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => results.push([n, ok, d]);

/**
 * A `usageEvent` the way AWS documents it: an INCREMENTAL `details.delta` and a
 * SESSION-CUMULATIVE `details.total` / `totalInputTokens` beside it.
 *
 * The running totals below are what make this fake able to catch the mistake it
 * exists to catch. An earlier version of this file set `total` equal to `delta`
 * on every event, which meant reading the wrong one produced exactly the same
 * number — the check passed, and swapping the provider to `details.total` was
 * caught by nothing. A fake whose two branches agree cannot test which branch
 * you took.
 */
let runSpeechIn = 0;
let runTextIn = 0;
let runSpeechOut = 0;
let runTextOut = 0;
const resetUsage = () => {
  runSpeechIn = runTextIn = runSpeechOut = runTextOut = 0;
};

const USAGE_DELTA = (speechIn: number, textIn: number, speechOut: number, textOut: number) => {
  runSpeechIn += speechIn;
  runTextIn += textIn;
  runSpeechOut += speechOut;
  runTextOut += textOut;
  return {
    completionId: 'c1',
    promptName: 'p',
    sessionId: 's',
    details: {
      delta: {
        input: { speechTokens: speechIn, textTokens: textIn },
        output: { speechTokens: speechOut, textTokens: textOut },
      },
      total: {
        input: { speechTokens: runSpeechIn, textTokens: runTextIn },
        output: { speechTokens: runSpeechOut, textTokens: runTextOut },
      },
    },
    // Deliberately absurd: a provider that reads the flat totals instead of the
    // deltas produces a number nobody could mistake for a real bill.
    totalInputTokens: 999_999,
    totalOutputTokens: 999_999,
    totalTokens: 1_999_998,
  };
};

/* ============ 1. the preamble is the one order Nova accepts ============ */
{
  const { session } = await open();
  const seq = order();

  check('the preamble is sessionStart -> promptStart -> system text -> audio contentStart',
    JSON.stringify(seq) ===
      JSON.stringify(['sessionStart', 'promptStart', 'contentStart', 'textInput', 'contentEnd', 'contentStart']),
    seq.join(' -> '));

  const sessionStart = sentOf('sessionStart')[0];
  check('Nova 2 gets a turnDetectionConfiguration',
    sessionStart?.turnDetectionConfiguration?.endpointingSensitivity === 'MEDIUM',
    JSON.stringify(sessionStart?.turnDetectionConfiguration));

  const promptStart = sentOf('promptStart')[0];
  check('output audio is declared at 24kHz PCM16 mono',
    promptStart?.audioOutputConfiguration?.sampleRateHertz === 24000 &&
      promptStart.audioOutputConfiguration.sampleSizeBits === 16 &&
      promptStart.audioOutputConfiguration.channelCount === 1 &&
      promptStart.audioOutputConfiguration.mediaType === 'audio/lpcm',
    JSON.stringify(promptStart?.audioOutputConfiguration));
  check('the voice travels verbatim, not case-folded',
    promptStart?.audioOutputConfiguration?.voiceId === 'tiffany',
    promptStart?.audioOutputConfiguration?.voiceId);

  const [sysStart, audioStart] = sentOf('contentStart');
  check('the system prompt is a SYSTEM TEXT block, interactive: false',
    sysStart?.role === 'SYSTEM' && sysStart.type === 'TEXT' && sysStart.interactive === false,
    JSON.stringify({ role: sysStart?.role, type: sysStart?.type, interactive: sysStart?.interactive }));
  check('the system prompt text is the one the config asked for',
    sentOf('textInput')[0]?.content === 'Speak clearly and briefly.',
    sentOf('textInput')[0]?.content);
  check('the audio block is a USER AUDIO block, interactive: true, 16kHz',
    audioStart?.role === 'USER' && audioStart.type === 'AUDIO' && audioStart.interactive === true &&
      audioStart.audioInputConfiguration?.sampleRateHertz === 16000,
    JSON.stringify({ role: audioStart?.role, type: audioStart?.type, rate: audioStart?.audioInputConfiguration?.sampleRateHertz }));

  const promptName = promptStart?.promptName;
  check('one promptName is repeated across every event that carries one',
    !!promptName && received.every((m) => {
      const body = Object.values(m.event ?? {})[0] as Json;
      return body?.promptName === undefined || body.promptName === promptName;
    }));
  check('the system block and the audio block have DIFFERENT contentNames',
    !!sysStart?.contentName && !!audioStart?.contentName && sysStart.contentName !== audioStart.contentName);

  await session.close();
}

/* ============ 2. a language is never sent, because Nova has no field for one ============ */
/*
 * The catalog offers 10 locales for this provider and the UI will happily set
 * one. Nova takes no language parameter anywhere — forwarding it would be a
 * ValidationException on the first event. Guarded here because "add the
 * language, every other provider takes one" is the obvious-looking change.
 */
{
  const { session } = await open({ language: 'hi-IN' });
  const blob = JSON.stringify(received);
  check('no language field reaches the wire, under any spelling',
    !/"language"|"languageCode"|"locale"|hi-IN/.test(blob),
    blob.match(/"language\w*"\s*:\s*"[^"]*"/)?.[0] ?? '');
  await session.close();
}

/* ============ 3. t0 is the LOCAL speech-end, not a server event ============ */
/*
 * The load-bearing decision in this provider. Nova publishes no speech-end
 * event; its earliest server-side turn marker is `completionStart`, which only
 * arrives after a documented 1.5-2.0s endpointing pause. Taking t0 from there
 * would fold that pause into every latency number.
 *
 * So the turn must already be open BEFORE the server says anything at all.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();

  check('a turn opens on local speech-end, with no server event at all',
    rec.turnStarts.length === 1, `${rec.turnStarts.length}`);

  // Now the vendor reacts, a realistic ~1.7s later. The mark must NOT move.
  push({ completionStart: { completionId: 'c1', promptName: 'p', sessionId: 's' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(80).toString('base64') } });
  push({ contentEnd: { completionId: 'c1', contentId: 'b1', stopReason: 'END_TURN' } });
  push({ usageEvent: USAGE_DELTA(30, 12, 60, 20) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(120);

  const marks = rec.metrics[0]?.marks ?? [];
  const speechEnd = marks.find((m) => m.name === 'user_speech_end');
  check('user_speech_end is stamped at the turn open, not at completionStart',
    speechEnd?.atMs !== undefined && speechEnd.atMs < 20, `${speechEnd?.atMs}ms`);
  check('time-to-first-audio is measured from that mark',
    (rec.metrics[0]?.derived.timeToFirstAudioMs ?? -1) >= 0,
    String(rec.metrics[0]?.derived.timeToFirstAudioMs));
  check('exactly one turn ran', rec.turnEnds.length === 1, `${rec.turnEnds.length}`);
  await session.close();
}

/* ============ 4. a mid-sentence pause restamps t0 instead of inventing a turn ============ */
/*
 * The local detector ends an utterance after 600ms of silence; Nova waits
 * 1.5-2.0s. A user who pauses to think produces a speech-end Nova does not act
 * on, then another when they really finish. Opening a second turn there would
 * emit a turn_start/turn_end pair for a turn that never ran — and worse, would
 * leave t0 at the FIRST pause, understating nothing and overstating the
 * latency of the turn that did run.
 */
{
  const { session, rec } = await open();
  speakThenPause(session); // pause one: the user is thinking
  await settle(30);
  check('the pause opened a turn', rec.turnStarts.length === 1, `${rec.turnStarts.length}`);

  await settle(120); // time passes, Nova says nothing
  speakThenPause(session); // the user finishes for real
  await settle(30);

  check('a second speech-end on a PENDING turn opens no second turn',
    rec.turnStarts.length === 1, `${rec.turnStarts.length}`);
  check('...and emits no turn_end for a turn that never ran',
    rec.turnEnds.length === 0, `${rec.turnEnds.length}`);

  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(60).toString('base64') } });
  await settle(80);

  const speechEnd = (rec.metrics[0]?.marks ?? []).find((m) => m.name === 'user_speech_end');
  push({ usageEvent: USAGE_DELTA(10, 5, 20, 8) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(80);

  const ttfa = rec.metrics[0]?.derived.timeToFirstAudioMs ?? 0;
  check('t0 moved to the LATER speech-end, so TTFA is not inflated by the pause',
    ttfa < 150, `${ttfa}ms (speech_end mark at ${speechEnd?.atMs}ms)`);
  await session.close();
}

/* ============ 5. transcripts route by the block's role, and stage sets `final` ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();

  push({ completionStart: { completionId: 'c1' } });
  // Nova's ASR of the user, marked FINAL.
  push({ contentStart: { completionId: 'c1', contentId: 'u1', type: 'TEXT', role: 'USER',
    additionalModelFields: '{"generationStage":"FINAL"}' } });
  push({ textOutput: { completionId: 'c1', contentId: 'u1', content: 'how fast are you' } });
  push({ contentEnd: { completionId: 'c1', contentId: 'u1', stopReason: 'END_TURN' } });
  // The assistant's planned speech, marked SPECULATIVE.
  push({ contentStart: { completionId: 'c1', contentId: 'a1', type: 'TEXT', role: 'ASSISTANT',
    additionalModelFields: '{"generationStage":"SPECULATIVE"}' } });
  push({ textOutput: { completionId: 'c1', contentId: 'a1', content: 'Fast enough.' } });
  push({ contentEnd: { completionId: 'c1', contentId: 'a1', stopReason: 'PARTIAL_TURN' } });
  // Then the same thing as spoken, FINAL.
  push({ contentStart: { completionId: 'c1', contentId: 'a2', type: 'TEXT', role: 'ASSISTANT',
    additionalModelFields: '{"generationStage":"FINAL"}' } });
  push({ textOutput: { completionId: 'c1', contentId: 'a2', content: 'Fast enough.' } });
  push({ contentEnd: { completionId: 'c1', contentId: 'a2', stopReason: 'END_TURN' } });
  await settle(120);

  check('a USER-role block becomes a user transcript, not an assistant one',
    rec.user.some((u) => u.text === 'how fast are you') && !rec.assistant.some((a) => a.text.includes('how fast')),
    JSON.stringify(rec.user));
  check('generationStage FINAL marks the user transcript final',
    rec.user.find((u) => u.text === 'how fast are you')?.final === true);
  check('generationStage SPECULATIVE is delivered as a NON-final assistant line',
    rec.assistant[0]?.final === false, JSON.stringify(rec.assistant[0]));
  check('the FINAL assistant line is delivered as final',
    rec.assistant.at(-1)?.final === true, JSON.stringify(rec.assistant.at(-1)));
  check('assistant text is cumulative, not a bare fragment',
    (rec.assistant.at(-1)?.text ?? '').startsWith('Fast enough.'), rec.assistant.at(-1)?.text);

  // Marks only leave the provider in the turn's snapshot, so the turn has to
  // end before they can be inspected at all.
  push({ usageEvent: USAGE_DELTA(8, 3, 12, 4) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(120);
  const names = (rec.metrics[0]?.marks ?? []).map((m) => m.name);
  check('the ASR transcript marks stt_final, so the ASR leg is visible beside the s2s number',
    names.includes('stt_final'), names.join(', '));
  check('...and stt_first_partial, measured from the same t0',
    names.includes('stt_first_partial'), names.join(', '));
  check('sttLatencyMs is derived from user_speech_end, not from the vendor\'s clock',
    (rec.metrics[0]?.derived.sttLatencyMs ?? -1) >= 0, String(rec.metrics[0]?.derived.sttLatencyMs));

  await session.close();
}

/* ============ 6. an unreadable generationStage shows the text rather than hiding it ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'a1', type: 'TEXT', role: 'ASSISTANT',
    additionalModelFields: 'not json at all' } });
  push({ textOutput: { completionId: 'c1', contentId: 'a1', content: 'still say this' } });
  await settle(80);
  check('a malformed additionalModelFields does not swallow the transcript',
    rec.assistant.some((a) => a.text === 'still say this'), JSON.stringify(rec.assistant));
  check('...and no error is raised for it', rec.errors.length === 0, rec.errors.join('; '));
  await session.close();
}

/* ============ 7. barge-in, signal one: contentEnd stopReason INTERRUPTED ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(200).toString('base64') } });
  await settle(60);
  const before = audioBytes(rec);
  push({ contentEnd: { completionId: 'c1', contentId: 'b1', stopReason: 'INTERRUPTED' } });
  await settle(60);

  check('INTERRUPTED raises onInterrupt exactly once', rec.interrupts === 1, `${rec.interrupts}`);
  check('...and ends the turn', rec.turnEnds.length === 1, `${rec.turnEnds.length}`);

  // Audio still arriving for the abandoned completion must be dropped, not played.
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(200).toString('base64') } });
  await settle(60);
  check('audio for an interrupted turn is discarded, not played late',
    audioBytes(rec) === before, `${audioBytes(rec)} vs ${before}`);

  // Billing still lands: an interrupted turn cost real tokens.
  push({ usageEvent: USAGE_DELTA(40, 10, 25, 9) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(80);
  check('an interrupted turn is still billed, exactly once', rec.usage.length === 1, `${rec.usage.length}`);
  check('...from vendor counts, not a local guess', rec.usage[0]?.legs[0]?.source === 'vendor');
  await session.close();
}

/* ============ 8. barge-in, signal two: the literal text marker ============ */
/*
 * AWS's own Python handler greps text content for `{ "interrupted" : true }`.
 * It arrives AS the transcript, so a provider that routed text before checking
 * would read the marker out loud to the user as part of the answer.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(120).toString('base64') } });
  await settle(60);
  push({ contentStart: { completionId: 'c1', contentId: 't1', type: 'TEXT', role: 'ASSISTANT' } });
  push({ textOutput: { completionId: 'c1', contentId: 't1', content: '{ "interrupted" : true }' } });
  await settle(80);

  check('the text marker raises onInterrupt', rec.interrupts === 1, `${rec.interrupts}`);
  check('the marker is NEVER delivered as a transcript',
    !rec.assistant.some((a) => a.text.includes('interrupted')) && !rec.user.some((u) => u.text.includes('interrupted')),
    JSON.stringify([...rec.assistant, ...rec.user]));

  // Both signals commonly fire for one interruption. The second must be a no-op.
  push({ contentEnd: { completionId: 'c1', contentId: 'b1', stopReason: 'INTERRUPTED' } });
  await settle(60);
  check('a second interruption signal does not truncate the recording twice',
    rec.interrupts === 1, `${rec.interrupts}`);
  await session.close();
}

/* ============ 9. barge-in sends NOTHING upstream ============ */
/*
 * Nova publishes no cancel event and the audio content block spans the whole
 * conversation. Closing it to "stop" the model would end the conversation, not
 * the utterance — so the correct upstream behaviour is silence.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(100).toString('base64') } });
  await settle(60);

  const beforeCount = received.length;
  session.interrupt();
  await settle(80);

  check('a local interrupt sends no event to the vendor',
    received.length === beforeCount, order().slice(beforeCount).join(', '));
  check('...but still tells the recorder the audio was never heard', rec.interrupts === 1, `${rec.interrupts}`);
  check('...and the audio block is still open afterwards',
    !order().slice(beforeCount).includes('contentEnd'));

  // The conversation must still work after a barge-in.
  speakThenPause(session);
  await settle(60);
  check('a new turn can still open after barge-in', rec.turnStarts.length === 2, `${rec.turnStarts.length}`);
  await session.close();
}

/* ============ 10. usage: deltas accumulate, flat totals are ignored ============ */
/*
 * `usageEvent` carries an incremental `delta` AND a session-cumulative
 * `totalInputTokens`. Summing the flat totals across events multiplies the
 * bill; taking the last one bills every turn for the whole conversation. The
 * fake sends absurd flat totals so either mistake is unmissable.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(100).toString('base64') } });
  push({ usageEvent: USAGE_DELTA(20, 5, 30, 7) });
  push({ usageEvent: USAGE_DELTA(10, 3, 20, 5) });
  push({ contentEnd: { completionId: 'c1', contentId: 'b1', stopReason: 'END_TURN' } });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(120);

  const leg = rec.usage[0]?.legs[0];
  check('speech and text deltas are summed across every usage event',
    leg?.inputUnits === 38 && leg.outputUnits === 62,
    JSON.stringify({ in: leg?.inputUnits, out: leg?.outputUnits }));
  check('the flat session-cumulative totals are NOT used',
    (leg?.inputUnits ?? 0) < 1000 && (leg?.outputUnits ?? 0) < 1000,
    JSON.stringify({ in: leg?.inputUnits, out: leg?.outputUnits }));
  check('speech tokens are carried separately from text tokens',
    leg?.audioInputTokens === 30 && leg.audioOutputTokens === 50,
    JSON.stringify({ aIn: leg?.audioInputTokens, aOut: leg?.audioOutputTokens }));
  check('the containment invariant holds: each breakdown sits INSIDE its total',
    (leg?.audioInputTokens ?? 0) <= (leg?.inputUnits ?? 0) &&
      (leg?.audioOutputTokens ?? 0) <= (leg?.outputUnits ?? 0));
  check('the leg is one realtime row, denominated in tokens',
    rec.usage[0]?.legs.length === 1 && leg?.leg === 'realtime' && leg.unit === 'tokens');
  check('audioSeconds reports the speech actually emitted',
    Math.abs((leg?.audioSeconds ?? 0) - 0.1) < 0.02, String(leg?.audioSeconds));

  await session.close();
}

/* ============ 11. a turn that never ran is abandoned, not billed ============ */
/*
 * The live case: the local detector fires on a cough, Nova's own endpointing
 * never agrees a turn happened, and no completion is ever created. Billing it
 * would put a turn on the invoice that consumed nothing.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle(40);
  check('the cough opened a turn', rec.turnStarts.length === 1, `${rec.turnStarts.length}`);

  await session.close();
  await settle(60);
  check('a turn with no completion and no audio is not billed at all',
    rec.usage.length === 0, JSON.stringify(rec.usage));
  check('...and says so, rather than failing silently',
    rec.logs.some((l) => l.includes('produced no completion and was not billed')), rec.logs.join(' | '));
  check('the turn still ends, so the transport\'s turn_start is balanced',
    rec.turnEnds.length === 1, `${rec.turnEnds.length}`);
}

/* ============ 12. a turn that ran but was never costed is UNPRICED, never zero ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(100).toString('base64') } });
  await settle(60);

  await session.close();
  await settle(60);

  const leg = rec.usage[0]?.legs[0];
  check('a turn that ran without a usage event still bills exactly one row',
    rec.usage.length === 1, `${rec.usage.length}`);
  check('...marked local, because nothing was measured', leg?.source === 'local', String(leg?.source));
  check('...and unpriced, so the session total reads as a floor',
    (leg?.unpricedReason ?? '').length > 0, leg?.unpricedReason);
  check('...inventing no token counts',
    leg?.inputUnits === 0 && leg.outputUnits === 0,
    JSON.stringify({ in: leg?.inputUnits, out: leg?.outputUnits }));

  const { priceLeg } = await ratesFor('us-east-1');
  const priced = priceLeg(leg!);
  check('pricing an unpriced leg does not produce a confident $0.00',
    !priced.cost && !!priced.unpricedReason, JSON.stringify(priced.cost));
}

/* ============ 13. teardown order, which frees vendor capacity ============ */
{
  const { session } = await open();
  speakThenPause(session);
  await settle(40);
  await session.close();
  await settle(120);

  const tail = order().slice(-3);
  check('close() sends contentEnd -> promptEnd -> sessionEnd, in that order',
    JSON.stringify(tail) === JSON.stringify(['contentEnd', 'promptEnd', 'sessionEnd']), tail.join(' -> '));
  check('the closing contentEnd names the AUDIO block, not the system one',
    sentOf('contentEnd').at(-1)?.contentName === sentOf('contentStart')[1]?.contentName,
    `${sentOf('contentEnd').at(-1)?.contentName}`);

  const before = received.length;
  await session.close();
  await settle(60);
  check('a second close() is a no-op', received.length === before, `${received.length} vs ${before}`);
}

/* ============ 14. the stream dropping under us is surfaced and billed ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(80).toString('base64') } });
  await settle(60);

  serverWs?.close(1011, 'upstream gone');
  await settle(200);

  check('an unexpected stream close is surfaced to the caller',
    rec.errors.some((e) => e.includes('closed unexpectedly')), rec.errors.join('; '));
  check('the dropped stream still bills the turn exactly once',
    rec.usage.length === 1, `${rec.usage.length}`);
  check('...as unpriced, saying the stream closed first',
    (rec.usage[0]?.legs[0]?.unpricedReason ?? '').includes('stream closed'),
    rec.usage[0]?.legs[0]?.unpricedReason);

  await session.close();
  check('closing after a stream drop adds no second row', rec.usage.length === 1, `${rec.usage.length}`);
}

/* ============ 15. manual turn detection takes t0 from the mic release ============ */
/*
 * Nova cannot be told to stop endpointing — the audio block stays open and the
 * vendor decides. What manual mode changes is WHERE t0 comes from, and that the
 * local detector must not also be stamping one.
 */
{
  const { session, rec } = await open({ turnDetection: 'manual' });
  speakThenPause(session);
  await settle(40);
  check('the local detector does NOT open a turn in manual mode',
    rec.turnStarts.length === 0, `${rec.turnStarts.length}`);

  session.commitAudio();
  await settle(40);
  check('releasing the mic opens exactly one turn', rec.turnStarts.length === 1, `${rec.turnStarts.length}`);

  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(60).toString('base64') } });
  push({ usageEvent: USAGE_DELTA(5, 2, 8, 3) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(120);
  check('the manual turn completes and bills', rec.usage.length === 1, `${rec.usage.length}`);
  await session.close();
}

/* ============ 16. typed input is a USER TEXT block, and opens its own turn ============ */
{
  const { session, rec } = await open({ turnDetection: 'manual' });
  session.sendText('what is the refund window');
  await settle(60);

  const typed = sentOf('contentStart').at(-1);
  check('typed text is a USER TEXT block with interactive: true',
    typed?.role === 'USER' && typed.type === 'TEXT' && typed.interactive === true,
    JSON.stringify({ role: typed?.role, type: typed?.type, interactive: typed?.interactive }));
  check('typed text is closed with its own contentEnd',
    sentOf('contentEnd').at(-1)?.contentName === typed?.contentName);
  check('typed text does NOT reuse the audio block\'s contentName',
    typed?.contentName !== sentOf('contentStart')[1]?.contentName);
  check('typed text opens a turn and echoes as a final user transcript',
    rec.turnStarts.length === 1 && rec.user.at(-1)?.final === true,
    JSON.stringify(rec.user.at(-1)));
  await session.close();
}

/* ============ 17. a late event from a retired completion cannot hijack the live turn ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(60).toString('base64') } });
  push({ usageEvent: USAGE_DELTA(9, 3, 11, 4) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(120);
  const firstUsage = rec.usage.length;
  const bytesAfterTurn1 = audioBytes(rec);

  // Turn two opens; a straggler from turn one arrives. On Nova this window is
  // the ENDPOINTING PAUSE — 1.5-2.0s during which the new turn has not yet
  // bound a completionId — so it is wide, not a millisecond race.
  speakThenPause(session);
  await settle(40);
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(400).toString('base64') } });
  push({ usageEvent: USAGE_DELTA(500, 500, 500, 500) }); // a late usage duplicate for c1
  await settle(80);

  /*
   * These used to assert `rec.metrics.length === 1`, which is true whether or
   * not the straggler was played — metrics only leave the provider at turn end.
   * The check was vacuous and it hid a live bug: the straggler WAS played, it
   * stamped `first_audio_out` on turn 2, and turn 2's headline TTFA came out at
   * ~40ms for audio that had not arrived yet. Assert the bytes.
   */
  check('audio from a retired completion is not played into the new turn',
    audioBytes(rec) === bytesAfterTurn1, `${audioBytes(rec) - bytesAfterTurn1} straggler bytes reached the sink`);
  check('...and does not bill the new turn with the old one\'s counts',
    rec.usage.length === firstUsage, `${rec.usage.length}`);

  push({ completionStart: { completionId: 'c2' } });
  push({ contentStart: { completionId: 'c2', contentId: 'b2', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c2', contentId: 'b2', content: tone(60).toString('base64') } });
  push({ usageEvent: { ...USAGE_DELTA(4, 1, 6, 2), completionId: 'c2' } });
  push({ completionEnd: { completionId: 'c2', stopReason: 'END_TURN' } });
  await settle(120);
  check('turn two bills its OWN counts',
    rec.usage[1]?.legs[0]?.inputUnits === 5, String(rec.usage[1]?.legs[0]?.inputUnits));
  check('...and the late usage for the retired completion is not billed twice',
    (rec.usage[1]?.legs[0]?.inputUnits ?? 0) < 100, String(rec.usage[1]?.legs[0]?.inputUnits));
  const t2 = rec.metrics.find((m) => m.turnId === 2);
  check('turn two\'s TTFA is measured from ITS audio, not the previous turn\'s',
    (t2?.derived.timeToFirstAudioMs ?? 0) > 100, `${t2?.derived.timeToFirstAudioMs}ms`);
  await session.close();
}

/* ============ 17b. a phantom turn cannot be resurrected by a stray usage event ============ */
/*
 * The compound failure the straggler bug enabled: a late `usageEvent` for a
 * RETIRED completion landed on a turn Nova never answered, set `sawUsage` on
 * it, and so defeated the "a turn that never ran is not billed" guard — an
 * invented turn, invoiced, marked `source: 'vendor'` with no unpriced reason.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(60).toString('base64') } });
  push({ usageEvent: USAGE_DELTA(100, 10, 200, 20) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(140);

  speakThenPause(session);        // a cough. Nova never opens a completion for it.
  await settle(40);
  push({ usageEvent: USAGE_DELTA(100, 10, 200, 20) });  // late duplicate for c1
  await settle(100);
  await session.close();
  await settle(80);

  check('a phantom turn is not resurrected by a retired completion\'s usage',
    rec.usage.length === 1, JSON.stringify(rec.usage.map((u) => ({ t: u.turnId, in: u.legs[0].inputUnits }))));
  check('...and is still reported as never billed',
    rec.logs.some((l) => l.includes('produced no completion and was not billed')), rec.logs.join(' | '));
}

/* ============ 17c. overlapping completions: neither turn loses its bill ============ */
/*
 * A second `completionStart` used to overwrite the id in place, which threw the
 * first completion's bill away entirely: its own usage and completionEnd then
 * matched no turn and were dropped, so tokens AWS had already charged for never
 * reached the invoice.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(60).toString('base64') } });
  await settle(60);
  push({ completionStart: { completionId: 'c2' } });   // overlaps c1
  await settle(60);
  push({ usageEvent: USAGE_DELTA(100, 10, 200, 20) }); // belongs to c1
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  push({ usageEvent: { ...USAGE_DELTA(1, 1, 1, 1), completionId: 'c2' } });
  push({ completionEnd: { completionId: 'c2', stopReason: 'END_TURN' } });
  await settle(160);

  const billed = rec.usage.map((u) => u.legs[0].inputUnits).sort((a, b) => b - a);
  check('an overlapped completion still bills its own tokens',
    billed.includes(110), JSON.stringify(rec.usage.map((u) => ({ t: u.turnId, in: u.legs[0].inputUnits }))));
  check('...and the overlap is reported rather than silently absorbed',
    rec.logs.some((l) => l.includes('while') && l.includes('still live')), rec.logs.join(' | '));
  await session.close();
}

/* ============ 17d. barge-in through the LOCAL detector tells the recorder ============ */
/*
 * The ordinary voice barge-in path under server VAD, and the one that was
 * missing: the user talks over the assistant, the local detector opens the next
 * turn, and the turn still speaking is closed. `endTurn` did not raise
 * `onInterrupt`, so seconds of never-heard speech stayed in the stereo
 * recording and displaced every later assistant turn in the file.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(3000).toString('base64') } });
  await settle(100);

  speakThenPause(session);   // the user talks over it
  await settle(60);
  check('a local-detector barge-in raises onInterrupt so the recorder truncates',
    rec.interrupts === 1, `${rec.interrupts}`);

  push({ contentEnd: { completionId: 'c1', contentId: 'b1', stopReason: 'INTERRUPTED' } });
  await settle(60);
  check('...and the vendor\'s own INTERRUPTED arriving later does not truncate twice',
    rec.interrupts === 1, `${rec.interrupts}`);
  await session.close();
}

/* ============ 17e. a turn that emitted nothing is not a barge-in ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);            // turn 1, no audio ever emitted
  await settle(40);
  push({ completionStart: { completionId: 'c1' } });
  await settle(40);
  speakThenPause(session);            // turn 2 opens, closing the silent turn 1
  await settle(60);
  check('closing a turn that emitted no audio raises no onInterrupt',
    rec.interrupts === 0, `${rec.interrupts}`);
  await session.close();
}

/* ============ 17f. an interruption labelled with the PREVIOUS completion ============ */
/*
 * Typing mid-answer opens the next turn first, so the interruption that the
 * typing CAUSED arrives labelled with the previous completion. Ending
 * `this.active` there killed the turn the user had just started: it emitted an
 * empty turn_start/turn_end pair, stranded the user's own text on it, and
 * pushed the real answer onto a third turn whose t0 was the completion start —
 * i.e. Nova's endpointing pause, the exact thing t0 is defined to exclude.
 */
{
  const { session, rec } = await open({ turnDetection: 'manual' });
  session.commitAudio();
  await settle(40);
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: tone(500).toString('base64') } });
  await settle(80);

  session.sendText('actually, never mind');          // opens turn 2
  await settle(40);
  push({ contentEnd: { completionId: 'c1', contentId: 'b1', stopReason: 'INTERRUPTED' } });
  await settle(80);
  push({ completionStart: { completionId: 'c2' } });
  push({ contentStart: { completionId: 'c2', contentId: 'b2', type: 'AUDIO', role: 'ASSISTANT' } });
  push({ audioOutput: { completionId: 'c2', contentId: 'b2', content: tone(60).toString('base64') } });
  await settle(100);

  check('an interruption labelled with the OLD completion does not kill the new turn',
    rec.turnStarts.length === 2, `turns opened: ${rec.turnStarts.join(',')}`);
  check('...so the typed text and the answer land on the SAME turn',
    rec.user.at(-1)?.turnId === 2 && rec.metrics.every((m) => m.turnId !== 3),
    `user on turn ${rec.user.at(-1)?.turnId}`);
  check('...and no "completion with no turn open" warning is raised',
    !rec.logs.some((l) => l.includes('no turn open')), rec.logs.join(' | '));
  await session.close();
}

/* ============ 18. the session boundary rate is read, not assumed ============ */
/*
 * Every scenario above runs at CANONICAL_SAMPLE_RATE, where the OUTBOUND
 * resample is a no-op — delete it and the suite stays green. The invariant is
 * that a provider converts against the rate it was given rather than the
 * constant, so it stays correct if the boundary ever moves.
 */
{
  const { session, rec } = await open();
  (session as unknown as { sessionRate: number }).sessionRate = 16000;

  // Up is a no-op here (16k boundary, 16k vendor) — down is the interesting one,
  // so check the in-leg by byte count at a rate where it must convert.
  const mic = tone(60, 220, 16000); // 960 samples = 1920 bytes
  session.pushAudio(mic);
  await settle(40);
  const appended = sentOf('audioInput').at(-1);
  const upBytes = appended ? Buffer.from(appended.content, 'base64').length : 0;
  check('mic audio is converted from the BOUNDARY rate to Nova\'s 16kHz input rate',
    upBytes === mic.length, `${upBytes} bytes from ${mic.length}`);

  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  const spoken = tone(60); // 1440 samples @ 24kHz = 2880 bytes
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: spoken.toString('base64') } });
  await settle(80);
  const downBytes = audioBytes(rec);
  check('vendor audio is resampled DOWN from 24kHz to the boundary rate',
    downBytes === Math.floor((spoken.length / 2) * (16000 / 24000)) * 2,
    `${downBytes} bytes from ${spoken.length}`);

  push({ usageEvent: USAGE_DELTA(1, 1, 1, 1) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(100);
  // 1440 samples at 24kHz is 60ms and stays 60ms at 16kHz: a moved boundary
  // must not restate the LENGTH of the audio.
  check('audioSeconds is a duration, unchanged by the boundary rate',
    Math.abs((rec.usage[0]?.legs[0]?.audioSeconds ?? 0) - 0.06) < 0.005,
    String(rec.usage[0]?.legs[0]?.audioSeconds));
  check('the rate asked OF the vendor does not follow the boundary',
    sentOf('promptStart')[0]?.audioOutputConfiguration?.sampleRateHertz === 24000 &&
      sentOf('contentStart')[1]?.audioInputConfiguration?.sampleRateHertz === 16000);
  await session.close();
}

/* ============ 19. a frame that is not JSON must not take the session down ============ */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  pushRaw('<html><body>502 Bad Gateway</body></html>');
  pushRaw('{"event":{"audioOutput":');
  await settle(60);
  check('a non-JSON frame raises no error of its own', rec.errors.length === 0, rec.errors.join('; '));

  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'AUDIO', role: 'ASSISTANT' } });
  const spoken = tone(40);
  push({ audioOutput: { completionId: 'c1', contentId: 'b1', content: spoken.toString('base64') } });
  push({ usageEvent: USAGE_DELTA(2, 1, 3, 1) });
  push({ completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } });
  await settle(140);

  check('events after a malformed frame are still handled',
    audioBytes(rec) === spoken.length, `${audioBytes(rec)}`);
  check('the turn still ends and bills exactly once',
    rec.turnEnds.length === 1 && rec.usage.length === 1, `${rec.turnEnds.length}/${rec.usage.length}`);
  await session.close();
}

/* ============ 20. an unsolicited tool request is reported, not silently dropped ============ */
/*
 * No tools are configured, so this should never happen. If it does, the model
 * is waiting on a toolResult that is never coming and the turn simply stalls —
 * a log line is the difference between a diagnosable stall and a mystery.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'b1', type: 'TOOL', role: 'ASSISTANT' } });
  push({ toolUse: { completionId: 'c1', contentId: 'b1', toolName: 'get_weather', toolUseId: 'tu1', content: '{}' } });
  await settle(80);
  check('an unserved toolUse is logged with the tool name',
    rec.logs.some((l) => l.includes('get_weather')), rec.logs.join(' | '));
  await session.close();
}

/* ============ 21. the speech/text split actually prices, to the cent ============ */
/*
 * The Nova rate had NO test behind it: setting all four us-east-1 numbers to
 * zero left the whole suite green, because the only assertion was
 * `!!priced.cost || !!priced.unpricedReason` — and `priceLeg` always sets
 * exactly one of those, so it was a tautology that could not fail.
 *
 * The expected figures below are computed BY HAND from the rates
 * `npm run nova:rates` reads off AWS, so if the table drifts these go red
 * rather than quietly following it:
 *
 *   us-east-1  1100 speech-in  x $3.00/1M  = 0.0033
 *               100 text-in    x $0.33/1M  = 0.000033
 *               750 speech-out x $12.00/1M = 0.009
 *                50 text-out   x $2.75/1M  = 0.0001375
 *                                    total = 0.0124705
 */
{
  const leg = (): LegUsage => ({
    leg: 'realtime', providerId: 'aws-nova-sonic', modelId: 'amazon.nova-2-sonic-v1:0',
    unit: 'tokens', inputUnits: 1200, outputUnits: 800,
    audioInputTokens: 1100, audioOutputTokens: 750, source: 'vendor',
  });

  const us = await ratesFor('us-east-1');
  const usCost = us.priceLeg(leg()).cost;
  check('us-east-1 prices a split speech/text leg to the hand-computed cent',
    Math.abs((usCost?.amountUsd ?? 0) - 0.0124705) < 1e-9, String(usCost?.amountUsd));
  check('...in USD, the currency AWS actually bills in',
    usCost?.currency === 'USD', usCost?.currency);
  check('...and names the region in the rate string, since the price depends on it',
    (usCost?.rate ?? '').includes('us-east-1'), usCost?.rate);

  // Tokyo is 21% more for the same tokens. A region fallback would hide that.
  const tokyo = await ratesFor('ap-northeast-1');
  const tokyoCost = tokyo.priceLeg(leg()).cost;
  check('ap-northeast-1 prices the SAME leg 21% higher, hand-computed',
    Math.abs((tokyoCost?.amountUsd ?? 0) - 0.01508815) < 1e-9, String(tokyoCost?.amountUsd));
  check('...so the region genuinely changes the bill, rather than being cosmetic',
    (tokyoCost?.amountUsd ?? 0) > (usCost?.amountUsd ?? 0));

  // The speech half dominates: billing it at the text rate would understate the
  // turn ~9x while still looking like a number. This is what the split is FOR.
  const textOnly = us.priceLeg({ ...leg(), audioInputTokens: 0, audioOutputTokens: 0 });
  check('billing the same tokens as TEXT would understate the turn several-fold',
    (textOnly.cost?.amountUsd ?? 0) * 4 < (usCost?.amountUsd ?? 0),
    `text-only ${textOnly.cost?.amountUsd} vs split ${usCost?.amountUsd}`);

  const unlisted = await ratesFor('ca-central-1');
  const unlistedLeg = unlisted.priceLeg(leg());
  check('a region with no published rate is UNPRICED, not silently us-east-1',
    !unlistedLeg.cost && !!unlistedLeg.unpricedReason, JSON.stringify(unlistedLeg.cost));

  const legacy = us.priceLeg({ ...leg(), modelId: 'amazon.nova-sonic-v1:0' });
  check('the legacy v1 model id has no rate on file and is not billed at v2 prices',
    !legacy.cost && !!legacy.unpricedReason, JSON.stringify(legacy.cost));

  const contradictory = us.priceLeg({ ...leg(), audioInputTokens: 5000 });
  check('a breakdown larger than its total is refused rather than clamped',
    !contradictory.cost && (contradictory.unpricedReason ?? '').includes('inconsistent'),
    contradictory.unpricedReason);
}

/* ============ 22. credentials come from ctx, NEVER process.env ============ */
/*
 * This check used to be unable to fail. The env vars were deleted before the
 * only case that could observe a leak ran, so a provider reading
 * `process.env.AWS_ACCESS_KEY_ID ?? creds.AWS_ACCESS_KEY_ID` passed happily —
 * in CI, where a real key is present, that is precisely the wrong answer.
 *
 * So the environment is POPULATED here, and `NOVA_SONIC_WS_BASE` is withheld:
 * the provider must still refuse to start, because the only keys it is allowed
 * to see are the ones in `ctx.credentials`, and there are none.
 */
{
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.AWS_ACCESS_KEY_ID = 'process-env-key-that-must-not-be-used';
  process.env.AWS_SECRET_ACCESS_KEY = 'process-env-secret-that-must-not-be-used';

  const events: SessionEvents = {
    onUserTranscript: () => {}, onAssistantTranscript: () => {}, onAudio: () => {},
    onTurnStart: () => {}, onTurnEnd: () => {}, onMetrics: () => {}, onUsage: () => {},
    onLog: () => {}, onError: () => {},
  };
  const session = provider.createSession({
    sessionId: 'nokey',
    config: {
      mode: 'realtime', realtimeProviderId: 'aws-nova-sonic',
      realtimeModelId: 'amazon.nova-2-sonic-v1:0',
      systemPrompt: 'x', turnDetection: 'server_vad',
    },
    events,
    credentials: {}, // nothing at all — not even the fake transport's base
  });
  let message = '';
  try {
    await session.start();
  } catch (err) {
    message = (err as Error).message;
  }
  check('start() refuses even though AWS keys ARE in process.env',
    message.includes('AWS_ACCESS_KEY_ID'), message || 'start() resolved — the provider read process.env');

  // And the fake transport must still be reachable with no AWS keys in ctx.
  const { session: s2, rec } = await open();
  check('a session with no AWS keys in ctx.credentials runs on the injected endpoint',
    rec.errors.length === 0 && sentOf('sessionStart').length === 1, rec.errors.join('; '));
  await s2.close();

  if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = saved.id;
  if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
}

/* ============ 23. interleaved content blocks route by contentId, not by luck ============ */
/*
 * Every transcript scenario above opens a block and immediately sends its text,
 * so the "last block opened" fallback happens to be right every time — the
 * `contentId` map could be deleted entirely and the suite stayed green. Nova
 * opens the USER ASR block and the ASSISTANT block before the text of either
 * arrives, and then the fallback publishes the model's answer as the USER's own
 * words.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  push({ completionStart: { completionId: 'c1' } });
  push({ contentStart: { completionId: 'c1', contentId: 'u1', type: 'TEXT', role: 'USER',
    additionalModelFields: '{"generationStage":"FINAL"}' } });
  push({ contentStart: { completionId: 'c1', contentId: 'a1', type: 'TEXT', role: 'ASSISTANT',
    additionalModelFields: '{"generationStage":"FINAL"}' } });
  // Both blocks are open. Now the text arrives, oldest block first.
  push({ textOutput: { completionId: 'c1', contentId: 'u1', content: 'what is the refund window' } });
  push({ textOutput: { completionId: 'c1', contentId: 'a1', content: 'Thirty days.' } });
  await settle(120);

  check('the USER block\'s text is published as the user, with blocks interleaved',
    rec.user.some((u) => u.text === 'what is the refund window'), JSON.stringify(rec.user));
  check('the ASSISTANT block\'s text is published as the assistant, not as the user',
    rec.assistant.some((a) => a.text === 'Thirty days.') &&
      !rec.user.some((u) => u.text.includes('Thirty days')),
    JSON.stringify({ user: rec.user, assistant: rec.assistant }));
  await session.close();
}

/* ============ 24. a dead stream stops accepting microphone audio ============ */
/*
 * The transport layer above does not tear a session down on `onError` — it only
 * forwards the message to the browser. So after the stream died the session
 * stayed open and kept feeding mic frames into a queue nothing would ever drain
 * again, for as long as the tab held the microphone: ~43 KB/s of retained
 * base64 with no consumer.
 */
{
  const { session, rec } = await open();
  speakThenPause(session);
  await settle();
  serverWs?.close(1011, 'upstream gone');
  await settle(200);
  check('the dropped stream is reported', rec.errors.some((e) => e.includes('closed unexpectedly')));

  /*
   * Asserted on the session's own state rather than on what the fake received.
   * Once the fake's socket is closed nothing arrives either way, so counting
   * frames at the far end cannot tell "the session stopped accepting audio"
   * from "the socket was shut". The flag is what `pushAudio` actually gates on,
   * and reading it directly is the same shape as the sessionRate check above.
   */
  check('a dead stream marks the session closed, so pushAudio stops feeding the queue',
    (session as unknown as { closed: boolean }).closed === true,
    String((session as unknown as { closed: boolean }).closed));

  const before = received.length;
  for (let i = 0; i < 40; i++) session.pushAudio(tone(60, 220, 24000));
  await settle(80);
  check('...and no post-mortem mic frame reaches the transport',
    received.length === before, `${received.length - before} frames accepted post-mortem`);
  await session.close();
}

/* ============ 25. teardown is AWAITED, so it can actually reach the vendor ============ */
/*
 * `close()` queued contentEnd/promptEnd/sessionEnd and then destroyed the
 * transport in the same synchronous run. The SDK pulls from the queue on a
 * microtask that cannot run until `close()` yields, so on the real transport the
 * HTTP/2 session was already gone by the time those three were pulled and none
 * of them ever went out — while this suite's WebSocket fake, which sends
 * synchronously, showed them leaving and proved only the ORDER.
 *
 * The fake cannot reproduce the microtask ordering, so what is asserted here is
 * the contract that fixes it: `endInput()` is awaitable and resolves only once
 * the queue has actually drained.
 */
{
  const { EventQueue } = await import('../src/providers/realtime/NovaSonicProvider.js') as any;
  if (typeof EventQueue === 'function') {
    const q = new EventQueue();
    q.push({ event: { contentEnd: {} } });
    q.push({ event: { promptEnd: {} } });
    q.push({ event: { sessionEnd: {} } });
    let pulled = 0;
    const consume = (async () => { for await (const _ of q.stream()) pulled += 1; })();
    q.close();
    await q.whenDrained;
    check('whenDrained resolves only after every queued event has been pulled',
      pulled === 3, `${pulled} of 3 pulled`);
    await consume;

    // The other half of the leak: a closed queue must not retain what is
    // pushed into it afterwards, or a dead stream accumulates mic frames.
    const dead = new EventQueue();
    dead.close();
    for (let i = 0; i < 100; i++) dead.push({ event: { audioInput: {} } });
    let pulledAfter = 0;
    for await (const _ of dead.stream()) pulledAfter += 1;
    check('a closed queue retains nothing pushed after it',
      pulledAfter === 0, `${pulledAfter} events retained`);
  } else {
    check('EventQueue is exported so the drain contract can be tested', false, 'not exported');
  }
}

/* ------------------------------- report ------------------------------- */

let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  -> ${d}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
console.log('\nReminder: the fake above agrees with the provider by construction.');
console.log('Nothing here says AWS accepts any of it — that is what `npm run nova:probe` is for.');
wss.close();
process.exit(failed ? 1 : 0);
