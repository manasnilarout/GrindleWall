/**
 * Verifies OpenAiRealtimeProvider's event handling against a local fake that
 * speaks OpenAI's Realtime dialect. Needs no API key and no network.
 *
 * READ THIS BEFORE TRUSTING A PASS: the fake server below is one I wrote, and it
 * accepts absolutely anything this provider sends it. So a green run proves that
 * this module parses the events, keeps t0 where it belongs, routes transcripts
 * to the right callbacks and bills each turn exactly once — and proves NOTHING
 * WHATSOEVER about what the real OpenAI endpoint accepts. Every wire shape in
 * the provider is doc-derived. NO live verification was performed: a key is present
 * in the environment, but a realtime session is billable and was not authorised. Until someone runs it against
 * wss://api.openai.com with a key, the request shape is unproven.
 *
 *   npx tsx scripts/openai-realtime-selftest.ts
 */
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { once } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import { OpenAiRealtimeProvider } from '../src/providers/realtime/OpenAiRealtimeProvider.js';
import type { SessionEvents, VoiceSession } from '../src/providers/types.js';
import type { DerivedMetrics, LegUsage, MetricMark, StartConfig } from '../src/shared/protocol.js';
import { tone } from '../src/audio/pcm.js';

/* ------------------------------- the fake ------------------------------- */

type Json = Record<string, any>;

let serverWs: ServerSocket | undefined;
let received: Json[] = [];
let lastHeaders: IncomingHttpHeaders = {};
let lastUrl = '';

const wss = new WebSocketServer({ port: 0 });
wss.on('connection', (ws, req) => {
  serverWs = ws;
  lastHeaders = req.headers;
  lastUrl = req.url ?? '';
  ws.on('message', (raw) => {
    let msg: Json = {};
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      /* keep empty */
    }
    received.push(msg);
    // The only thing the fake does unprompted: acknowledge the session, because
    // start() waits for `session.updated` before it reports the session ready.
    if (msg.type === 'session.update') {
      ws.send(JSON.stringify({ type: 'session.created', event_id: 'ev_created', session: {} }));
      ws.send(JSON.stringify({ type: 'session.updated', event_id: 'ev_updated', session: msg.session }));
    }
  });
});
await once(wss, 'listening');
const base = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/v1/realtime`;

/** Server -> client, for scripting a turn by hand. */
const push = (event: Json) => serverWs?.send(JSON.stringify(event));
/** Server -> client, bypassing JSON entirely. */
const pushRaw = (frame: string) => serverWs?.send(frame);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- harness ------------------------------- */

interface Recorder {
  audio: Buffer[];
  user: Array<{ text: string; final: boolean; turnId: number }>;
  assistant: Array<{ text: string; final: boolean; turnId: number }>;
  turnStarts: number[];
  turnEnds: number[];
  metrics: Array<{ turnId: number; marks: MetricMark[]; derived: DerivedMetrics }>;
  usage: Array<{ turnId: number; legs: LegUsage[] }>;
  errors: string[];
}

const provider = new OpenAiRealtimeProvider();

async function open(config: Partial<StartConfig> = {}): Promise<{ session: VoiceSession; rec: Recorder }> {
  received = [];
  const rec: Recorder = {
    audio: [], user: [], assistant: [], turnStarts: [], turnEnds: [], metrics: [], usage: [], errors: [],
  };
  const events: SessionEvents = {
    onUserTranscript: (text, final, turnId) => rec.user.push({ text, final, turnId }),
    onAssistantTranscript: (text, final, turnId) => rec.assistant.push({ text, final, turnId }),
    onAudio: (chunk) => rec.audio.push(chunk),
    onTurnStart: (turnId) => rec.turnStarts.push(turnId),
    onTurnEnd: (turnId) => rec.turnEnds.push(turnId),
    onMetrics: (turnId, marks, derived) => rec.metrics.push({ turnId, marks, derived }),
    onUsage: (turnId, legs) => rec.usage.push({ turnId, legs }),
    onLog: () => {},
    onError: (err) => rec.errors.push(err.message),
  };

  const session = provider.createSession({
    sessionId: 'selftest',
    config: {
      mode: 'realtime',
      realtimeProviderId: 'openai-realtime',
      realtimeModelId: 'gpt-realtime-2.1',
      systemPrompt: 'Speak clearly and briefly.',
      language: 'en-IN',
      voice: 'cedar',
      turnDetection: 'server_vad',
      ...config,
    },
    events,
    // Credentials only — the provider must never reach for process.env.
    credentials: { OPENAI_API_KEY: 'test-key', OPENAI_WS_BASE: base },
  });
  await session.start();
  return { session, rec };
}

const sentSession = (): Json => (received.find((m) => m.type === 'session.update')?.session ?? {}) as Json;
const sent = (type: string): Json[] => received.filter((m) => m.type === type);

const results: Array<[string, boolean, string?]> = [];
const check = (n: string, ok: boolean, d?: string) => results.push([n, ok, d]);

/** The usage object from OpenAI's own reference example, with the cached-audio
 *  split made non-zero so the containment assertions below are not vacuous. */
const USAGE = {
  total_tokens: 253,
  input_tokens: 132,
  output_tokens: 121,
  input_token_details: {
    text_tokens: 79,
    audio_tokens: 53,
    image_tokens: 0,
    cached_tokens: 64,
    cached_tokens_details: { text_tokens: 24, audio_tokens: 40, image_tokens: 0 },
  },
  output_token_details: { text_tokens: 30, audio_tokens: 91 },
};

/* ============================ 1. a normal turn ============================ */

{
  const { session, rec } = await open();

  /* --- 1a. the session config we put on the wire --- */
  const s = sentSession();
  check('session.update carries type:"realtime"', s.type === 'realtime', JSON.stringify(s.type));
  check('config is the nested GA shape, with an audio block',
    typeof s.audio === 'object' && s.audio !== null);
  check('no flat beta fields survive (input_audio_format / modalities / voice)',
    !('input_audio_format' in s) && !('output_audio_format' in s) && !('modalities' in s) && !('voice' in s) && !('turn_detection' in s),
    Object.keys(s).join(','));
  check('audio.input.format is {type:"audio/pcm", rate:24000}',
    JSON.stringify(s.audio?.input?.format) === JSON.stringify({ type: 'audio/pcm', rate: 24000 }),
    JSON.stringify(s.audio?.input?.format));
  check('audio.output.format is {type:"audio/pcm", rate:24000}',
    JSON.stringify(s.audio?.output?.format) === JSON.stringify({ type: 'audio/pcm', rate: 24000 }),
    JSON.stringify(s.audio?.output?.format));
  check('output_modalities is audio only (text and audio cannot be combined)',
    JSON.stringify(s.output_modalities) === '["audio"]', JSON.stringify(s.output_modalities));
  check('system prompt travels as session.instructions',
    s.instructions === 'Speak clearly and briefly.');
  check('server_vad configured with an explicit silence_duration_ms',
    s.audio?.input?.turn_detection?.type === 'server_vad' && s.audio.input.turn_detection.silence_duration_ms === 500,
    JSON.stringify(s.audio?.input?.turn_detection));
  check('input transcription enabled (the s2s model emits no user transcript)',
    typeof s.audio?.input?.transcription?.model === 'string', JSON.stringify(s.audio?.input?.transcription));
  check('language narrowed to ISO-639-1 for transcription',
    s.audio?.input?.transcription?.language === 'en', String(s.audio?.input?.transcription?.language));
  check('a built-in voice is sent as a bare string',
    s.audio?.output?.voice === 'cedar', JSON.stringify(s.audio?.output?.voice));
  check('no reasoning block without an @variant in the model id', !('reasoning' in s));

  /* --- 1b. auth --- */
  check('bearer token sent as an Authorization header',
    lastHeaders.authorization === 'Bearer test-key', String(lastHeaders.authorization));
  check('api key absent from the URL', !lastUrl.includes('test-key'), lastUrl);
  check('model travels in the query string', lastUrl.includes('model=gpt-realtime-2.1'), lastUrl);
  check('retired OpenAI-Beta header not sent', lastHeaders['openai-beta'] === undefined);

  /* --- 1c. mic audio --- */
  const mic = tone(40);
  session.pushAudio(mic);
  await settle();
  const append = sent('input_audio_buffer.append')[0];
  check('mic audio base64-encoded into input_audio_buffer.append',
    typeof append?.audio === 'string' && Buffer.from(append.audio, 'base64').equals(mic),
    append ? `${Buffer.from(append.audio, 'base64').length}B vs ${mic.length}B` : 'no append sent');

  /* --- 1d. t0 is the speech end, not the connect and not the response --- *
   * The scenario is scripted so BOTH edges are constrained. 300ms of dead air
   * before the speech end catches a t0 that drifts earlier (to the connect);
   * two measured gaps after it — one before the vendor even acknowledges the
   * turn, one of its think time — catch a t0 that drifts LATER, into the
   * vendor's own latency. Later is the dangerous direction: it silently
   * subtracts the vendor's slowness from the number the bench exists to
   * publish, and every check reads plausibly while it happens.
   */
  await settle(300);
  const speechEndAt = Date.now();
  push({ type: 'input_audio_buffer.speech_stopped', event_id: 'ev', audio_end_ms: 2000, item_id: 'item_user' });
  await settle();
  check('speech_stopped opens exactly one turn',
    rec.turnStarts.length === 1 && rec.turnStarts[0] === 1, rec.turnStarts.join(','));

  // Gap A: the vendor has not even acknowledged the turn yet. This is real
  // latency, and it belongs inside TTFA.
  await settle(180);
  push({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', usage: null } });
  push({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_user', delta: 'hello' });
  push({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_user', transcript: 'hello there' });
  // Gap B: the vendor's think time, between acknowledging and speaking.
  await settle(120);

  const spoken = tone(60);
  const firstAudioAt = Date.now();
  push({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'msg_1', delta: spoken.toString('base64') });
  push({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', item_id: 'msg_1', delta: 'Hi' });
  await settle();
  push({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'msg_1', delta: spoken.toString('base64') });
  push({ type: 'response.output_audio_transcript.done', response_id: 'resp_1', item_id: 'msg_1', transcript: 'Hi there.' });
  push({ type: 'response.output_audio.done', response_id: 'resp_1', item_id: 'msg_1' });
  push({ type: 'response.done', event_id: 'ev', response: { id: 'resp_1', status: 'completed', usage: USAGE } });
  await settle(120);

  /* --- 1e. audio and transcripts --- */
  const bytes = rec.audio.reduce((n, b) => n + b.length, 0);
  check('audio deltas reach onAudio, base64-decoded',
    bytes === spoken.length * 2, `${bytes} vs ${spoken.length * 2}`);
  check('user transcription routes to onUserTranscript',
    rec.user.some((t) => t.text === 'hello' && !t.final) && rec.user.some((t) => t.text === 'hello there' && t.final),
    JSON.stringify(rec.user));
  check('user transcript is attributed to the open turn',
    rec.user.every((t) => t.turnId === 1), JSON.stringify(rec.user.map((t) => t.turnId)));
  check('assistant transcript routes to onAssistantTranscript',
    rec.assistant.some((t) => t.text === 'Hi' && !t.final) && rec.assistant.some((t) => t.text === 'Hi there.' && t.final),
    JSON.stringify(rec.assistant));

  /* --- 1f. metrics --- */
  check('onMetrics fires exactly once for the turn',
    rec.metrics.length === 1 && rec.metrics[0].turnId === 1, `${rec.metrics.length}`);
  const m = rec.metrics[0];
  const ttfa = m?.derived.timeToFirstAudioMs;
  check('timeToFirstAudioMs is present and non-negative',
    ttfa !== undefined && ttfa >= 0, String(ttfa));

  // NOT "user_speech_end.atMs is small" — `TurnMetrics` starts its clock in its
  // constructor and `beginTurn` marks on the next line, so that number is ~0 by
  // construction and measures the gap between two adjacent statements. What
  // does carry information is that t0 is the EARLIEST thing recorded: a
  // provider that stamps it after the vendor's first partial, or does not stamp
  // it at all, is measuring from the wrong instant and this says so.
  const speechEndMark = m?.marks.find((k) => k.name === 'user_speech_end');
  check('user_speech_end is recorded, and is the earliest mark of the turn',
    speechEndMark !== undefined && m.marks.every((k) => k.atMs >= speechEndMark.atMs),
    JSON.stringify(m?.marks));
  // There is deliberately NO check here that `timeToFirstAudioMs` equals
  // `first_audio_out - user_speech_end`. It would read as rigour and be worth
  // nothing: this provider constructs `TurnMetrics` one line before it stamps
  // t0, so `user_speech_end.atMs` is ~0 in every scenario and the subtraction
  // is a no-op. Deleting it from `TurnMetrics.snapshot()` outright leaves this
  // whole suite green — verified. The wall-clock comparison below is what
  // actually constrains the number.

  // Calibrated against the wall clock rather than a hand-picked window, so the
  // assertion is as tight as the scheduler allows in BOTH directions.
  const scripted = firstAudioAt - speechEndAt;
  check('TTFA matches the gap the script actually scripted',
    ttfa !== undefined && Math.abs(ttfa - scripted) < 60, `${ttfa}ms vs ${scripted}ms scripted`);
  check('t0 is the speech end, not the response — the pre-response gap is inside TTFA',
    ttfa !== undefined && ttfa >= 280, `${ttfa}ms, and gaps A+B alone are 300ms`);
  check('t0 is the speech end, not the connect — the 300ms of dead air is outside it',
    ttfa !== undefined && ttfa < 500, `${ttfa}ms`);
  check('first_audio_out and last_audio_out both marked',
    m?.marks.some((k) => k.name === 'first_audio_out') === true && m?.marks.some((k) => k.name === 'last_audio_out') === true,
    m?.marks.map((k) => k.name).join(','));
  check('turn_end reported once', rec.turnEnds.length === 1 && rec.turnEnds[0] === 1, rec.turnEnds.join(','));

  /* --- 1g. billing --- */
  check('one usage row per turn', rec.usage.length === 1 && rec.usage[0].legs.length === 1,
    JSON.stringify(rec.usage.map((u) => u.legs.length)));
  const leg = rec.usage[0]?.legs[0];
  check('billed as the realtime leg, in tokens, from vendor counts',
    leg?.leg === 'realtime' && leg.unit === 'tokens' && leg.source === 'vendor',
    JSON.stringify({ leg: leg?.leg, unit: leg?.unit, source: leg?.source }));
  check('modelId is the catalog id', leg?.modelId === 'gpt-realtime-2.1', leg?.modelId);
  check('inputUnits = usage.input_tokens', leg?.inputUnits === 132, String(leg?.inputUnits));
  check('outputUnits = usage.output_tokens', leg?.outputUnits === 121, String(leg?.outputUnits));
  check('cachedInputTokens = input_token_details.cached_tokens',
    leg?.cachedInputTokens === 64, String(leg?.cachedInputTokens));
  check('audioInputTokens = input_token_details.audio_tokens',
    leg?.audioInputTokens === 53, String(leg?.audioInputTokens));
  check('audioOutputTokens = output_token_details.audio_tokens',
    leg?.audioOutputTokens === 91, String(leg?.audioOutputTokens));
  check('cachedAudioInputTokens = cached_tokens_details.audio_tokens',
    leg?.cachedAudioInputTokens === 40, String(leg?.cachedAudioInputTokens));

  // Containment: a total always INCLUDES its breakdown. Getting these backwards
  // does not throw anywhere — it just bills audio at the text rate, or bills the
  // same tokens twice, and nothing downstream can detect either.
  check('containment: audioInputTokens <= inputUnits',
    (leg?.audioInputTokens ?? 0) <= (leg?.inputUnits ?? 0));
  check('containment: cachedInputTokens <= inputUnits',
    (leg?.cachedInputTokens ?? 0) <= (leg?.inputUnits ?? 0));
  check('containment: cachedAudioInputTokens <= cachedInputTokens',
    (leg?.cachedAudioInputTokens ?? 0) <= (leg?.cachedInputTokens ?? 0));
  check('containment: cachedAudioInputTokens <= audioInputTokens',
    (leg?.cachedAudioInputTokens ?? 0) <= (leg?.audioInputTokens ?? 0));
  check('containment: audioOutputTokens <= outputUnits',
    (leg?.audioOutputTokens ?? 0) <= (leg?.outputUnits ?? 0));
  check('audioSeconds records what was actually emitted',
    Math.abs((leg?.audioSeconds ?? 0) - 0.12) < 0.01, String(leg?.audioSeconds));

  /* --- 1h. a repeat response.done must not bill twice --- */
  push({ type: 'response.done', event_id: 'ev2', response: { id: 'resp_1', status: 'completed', usage: USAGE } });
  await settle();
  check('a duplicate response.done does not bill the turn again', rec.usage.length === 1, `${rec.usage.length}`);


  /* --- 1i. an error event is surfaced and does not end the session --- */
  push({ type: 'error', event_id: 'ev3', error: { type: 'invalid_request_error', code: 'invalid_event', message: 'The type field is missing.' } });
  await settle();
  check('error events reach onError', rec.errors.some((e) => e.includes('The type field is missing.')), rec.errors.join('; '));
  session.pushAudio(tone(20));
  await settle();
  check('the session stays usable after a recoverable error',
    sent('input_audio_buffer.append').length >= 2, `${sent('input_audio_buffer.append').length}`);

  await session.close();
  check('close does not re-bill an already billed turn', rec.usage.length === 1, `${rec.usage.length}`);
}

/* ============================== 2. barge-in ============================== */

{
  const { session, rec } = await open();
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u2' });
  push({ type: 'response.created', response: { id: 'resp_2', status: 'in_progress' } });
  const spoken = tone(80);
  push({ type: 'response.output_audio.delta', response_id: 'resp_2', item_id: 'msg_2', delta: spoken.toString('base64') });
  await settle();

  const before = rec.audio.reduce((n, b) => n + b.length, 0);
  session.interrupt();
  await settle();

  const cancel = sent('response.cancel')[0];
  check('interrupt() sends response.cancel', cancel !== undefined);
  check('response.cancel names the in-flight response', cancel?.response_id === 'resp_2', JSON.stringify(cancel));
  const trunc = sent('conversation.item.truncate')[0];
  check('interrupt() truncates the assistant item to what was forwarded',
    trunc?.item_id === 'msg_2' && trunc.content_index === 0 && trunc.audio_end_ms === 80,
    JSON.stringify(trunc));
  check('output_audio_buffer.clear is not sent (it is WebRTC/SIP only)',
    sent('output_audio_buffer.clear').length === 0);
  check('barge-in ends the turn immediately', rec.turnEnds.length === 1, `${rec.turnEnds.length}`);
  check('barge-in reports metrics once', rec.metrics.length === 1, `${rec.metrics.length}`);

  // Deltas still in flight for the cancelled response must not be played late.
  push({ type: 'response.output_audio.delta', response_id: 'resp_2', item_id: 'msg_2', delta: spoken.toString('base64') });
  await settle();
  const after = rec.audio.reduce((n, b) => n + b.length, 0);
  check('audio arriving after barge-in is discarded', after === before, `${before} -> ${after}`);
  check('nothing is billed before response.done arrives', rec.usage.length === 0, `${rec.usage.length}`);

  push({
    type: 'response.done',
    response: { id: 'resp_2', status: 'cancelled', status_details: { reason: 'client_cancelled' }, usage: USAGE },
  });
  await settle();
  check('barge-in bills the turn exactly once', rec.usage.length === 1, `${rec.usage.length}`);
  check('a cancelled turn is still billed from vendor counts',
    rec.usage[0]?.legs[0]?.source === 'vendor' && rec.usage[0].legs[0].inputUnits === 132,
    JSON.stringify(rec.usage[0]?.legs[0]));

  await session.close();
  check('close after a billed barge-in adds no second row', rec.usage.length === 1, `${rec.usage.length}`);
}

/* ====================== 3. close with a turn in flight ====================== */

{
  const { session, rec } = await open();
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u3' });
  push({ type: 'response.created', response: { id: 'resp_3', status: 'in_progress' } });
  push({ type: 'response.output_audio.delta', response_id: 'resp_3', item_id: 'msg_3', delta: tone(40).toString('base64') });
  await settle();

  await session.close();
  await settle();
  check('close bills an unfinished turn exactly once', rec.usage.length === 1, `${rec.usage.length}`);
  const leg = rec.usage[0]?.legs[0];
  check('a turn the vendor never costed is not reported as a measurement',
    leg?.source === 'local', leg?.source);
  check('...and is flagged unpriced, so the session total is a floor',
    Boolean(leg?.unpricedReason), leg?.unpricedReason);
  check('close invents no token counts', leg?.inputUnits === 0 && leg.outputUnits === 0,
    JSON.stringify({ in: leg?.inputUnits, out: leg?.outputUnits }));
  check('close still reports the turn ended', rec.turnEnds.length === 1, `${rec.turnEnds.length}`);
}

/* ======================== 4. manual turn detection ======================== */

{
  const { session, rec } = await open({ turnDetection: 'manual' });
  const s = sentSession();
  check('manual turn detection sends turn_detection: null',
    'turn_detection' in (s.audio?.input ?? {}) && s.audio.input.turn_detection === null,
    JSON.stringify(s.audio?.input?.turn_detection));

  session.pushAudio(tone(40));
  await settle(300); // dead air again: t0 must be the commit, not the connect
  session.commitAudio();
  await settle();
  check('commitAudio sends input_audio_buffer.commit', sent('input_audio_buffer.commit').length === 1);
  check('commitAudio asks for a response (nothing else will)', sent('response.create').length === 1);
  check('commitAudio opens the turn', rec.turnStarts.length === 1, rec.turnStarts.join(','));

  push({ type: 'response.created', response: { id: 'resp_4', status: 'in_progress' } });
  await settle(120);
  push({ type: 'response.output_audio.delta', response_id: 'resp_4', item_id: 'msg_4', delta: tone(40).toString('base64') });
  push({ type: 'response.output_audio.done', response_id: 'resp_4', item_id: 'msg_4' });
  push({ type: 'response.done', response: { id: 'resp_4', status: 'completed', usage: USAGE } });
  await settle(120);

  const ttfa = rec.metrics[0]?.derived.timeToFirstAudioMs;
  check('manual mode reports one metrics row with a usable TTFA',
    rec.metrics.length === 1 && ttfa !== undefined && ttfa >= 0, `${rec.metrics.length} / ${ttfa}`);
  check('manual t0 is the commit, not the connect', ttfa !== undefined && ttfa >= 100 && ttfa < 280, `${ttfa}ms`);
  check('manual turn is billed exactly once', rec.usage.length === 1, `${rec.usage.length}`);
  await session.close();
}

/* =================== 5. voice ids and the @variant suffix =================== */

{
  const { session } = await open({ voice: 'voice_1234' });
  const s = sentSession();
  check('a non-built-in voice is sent as a custom {id} object',
    JSON.stringify(s.audio?.output?.voice) === JSON.stringify({ id: 'voice_1234' }),
    JSON.stringify(s.audio?.output?.voice));
  await session.close();
}

{
  const { session, rec } = await open({ realtimeModelId: 'gpt-realtime-2.1@low' });
  const s = sentSession();
  check('the @variant suffix is stripped off the wire model id',
    s.model === 'gpt-realtime-2.1', String(s.model));
  check('...and off the query string too', lastUrl.includes('model=gpt-realtime-2.1&') || lastUrl.endsWith('model=gpt-realtime-2.1'), lastUrl);
  check('the @variant becomes reasoning.effort', s.reasoning?.effort === 'low', JSON.stringify(s.reasoning));

  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 500, item_id: 'item_u5' });
  push({ type: 'response.created', response: { id: 'resp_5', status: 'in_progress' } });
  push({ type: 'response.done', response: { id: 'resp_5', status: 'completed', usage: USAGE } });
  await settle();
  check('the usage row keeps the full catalog model id, variant and all',
    rec.usage[0]?.legs[0]?.modelId === 'gpt-realtime-2.1@low', rec.usage[0]?.legs[0]?.modelId);
  await session.close();
}

/* ============ 6. deltas from a response the user has moved past ============ */
/*
 * Section 2 covers the easy half of this — a delta arriving for a turn that has
 * ENDED, with nothing open behind it. The half no fake here exercised is the one
 * that costs real numbers: a superseded response keeps streaming while a NEW
 * turn is already open, and "is there an active turn?" says yes to both. Its
 * late deltas then mark `first_audio_out` from the wrong response (the bench's
 * headline time-to-first-audio collapses towards zero), credit `audioBytes` to
 * the wrong usage row, overwrite `itemId` so a later `interrupt()` truncates the
 * wrong conversation item, and play the tail of an answer the user talked over.
 * Ownership has to be matched on `response_id`.
 */
{
  const { session, rec } = await open();

  /* --- turn 1: one response, streaming normally --- */
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u6a' });
  push({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
  const stale = tone(40);
  push({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'msg_1', delta: stale.toString('base64') });
  await settle();
  const played1 = rec.audio.reduce((n, b) => n + b.length, 0);
  check('turn 1 plays its own response', played1 === stale.length, `${played1} of ${stale.length}`);

  /* --- the user speaks again; resp_1 is still on the wire --- */
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 3000, item_id: 'item_u6b' });
  push({ type: 'response.created', response: { id: 'resp_2', status: 'in_progress' } });
  await settle();
  check('the second speech_stopped opens turn 2',
    rec.turnStarts.length === 2 && rec.turnStarts[1] === 2, rec.turnStarts.join(','));

  // Late, and belonging to nobody: resp_1's turn ended when turn 2 opened.
  push({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'msg_1', delta: stale.toString('base64') });
  await settle();
  check('a delta from the superseded response is not played onto the new turn',
    rec.audio.reduce((n, b) => n + b.length, 0) === played1,
    `${played1} -> ${rec.audio.reduce((n, b) => n + b.length, 0)}`);

  // The gap turn 2's time-to-first-audio must actually measure. If the late
  // delta above had been accepted, `first_audio_out` is already marked and this
  // gap is invisible.
  await settle(120);

  const fresh = tone(60);
  push({ type: 'response.output_audio.delta', response_id: 'resp_2', item_id: 'msg_2', delta: fresh.toString('base64') });
  await settle();
  check('a delta from the CURRENT response is played',
    rec.audio.reduce((n, b) => n + b.length, 0) === played1 + fresh.length,
    `${rec.audio.reduce((n, b) => n + b.length, 0)}`);

  // One more straggler, now that turn 2 has an itemId of its own to clobber.
  push({ type: 'response.output_audio.delta', response_id: 'resp_1', item_id: 'msg_1', delta: stale.toString('base64') });
  push({ type: 'response.output_audio_transcript.delta', response_id: 'resp_1', item_id: 'msg_1', delta: 'stale words' });
  await settle();
  check('stragglers stay dropped once the new turn is speaking',
    rec.audio.reduce((n, b) => n + b.length, 0) === played1 + fresh.length,
    `${rec.audio.reduce((n, b) => n + b.length, 0)}`);
  check('a superseded transcript delta does not caption the new turn',
    !rec.assistant.some((t) => t.text.includes('stale words')), JSON.stringify(rec.assistant));

  session.interrupt();
  await settle();
  const trunc = sent('conversation.item.truncate')[0];
  check('interrupt truncates the CURRENT item, not the superseded one',
    trunc?.item_id === 'msg_2', JSON.stringify(trunc));
  check('...at what turn 2 actually played, not what the old response added',
    trunc?.audio_end_ms === 60, String(trunc?.audio_end_ms));

  const m2 = rec.metrics.find((x) => x.turnId === 2);
  const ttfa2 = m2?.derived.timeToFirstAudioMs;
  check('turn 2 TTFA is measured from ITS first audio, not the old response\'s',
    ttfa2 !== undefined && ttfa2 >= 100 && ttfa2 < 320, `${ttfa2}ms`);

  push({ type: 'response.done', response: { id: 'resp_2', status: 'cancelled', usage: USAGE } });
  await settle();
  const leg2 = rec.usage.find((u) => u.turnId === 2)?.legs[0];
  check('the superseded response\'s audio is not billed to turn 2',
    Math.abs((leg2?.audioSeconds ?? 0) - 0.06) < 0.005, String(leg2?.audioSeconds));

  await session.close();
}

/* ========== 7. transcripts are cumulative, not raw vendor fragments ========== */
/*
 * `SessionEvents` is a cumulative channel: the browser REPLACES the trailing
 * non-final utterance with each string it receives (`pushUtterance` in
 * useVoiceSession), so every other session in this repo sends the whole string
 * so far. OpenAI streams fragments. Forwarding them raw made the caption show
 * one word at a time instead of growing — a bug tsc cannot see and which the
 * old fake, sending a single delta per turn, could not tell apart.
 */
{
  const { session, rec } = await open();
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u7' });
  push({ type: 'response.created', response: { id: 'resp_7', status: 'in_progress' } });
  await settle();

  for (const delta of ['Our ', 'refund ', 'window']) {
    push({ type: 'response.output_audio_transcript.delta', response_id: 'resp_7', item_id: 'msg_7', delta });
  }
  await settle();
  const grew = rec.assistant.filter((t) => !t.final).map((t) => t.text);
  check('assistant deltas arrive cumulatively, not as bare fragments',
    JSON.stringify(grew) === JSON.stringify(['Our ', 'Our refund ', 'Our refund window']),
    JSON.stringify(grew));

  for (const delta of ['thirty ', 'days']) {
    push({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_u7', delta });
  }
  await settle();
  const userGrew = rec.user.filter((t) => !t.final).map((t) => t.text);
  check('user deltas arrive cumulatively too',
    JSON.stringify(userGrew) === JSON.stringify(['thirty ', 'thirty days']), JSON.stringify(userGrew));

  // The s2s model emits no user transcript of its own, so this event is the ONLY
  // final the user side ever gets. Without it the browser renders the last
  // partial as provisional forever.
  push({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_u7', transcript: 'Thirty days?' });
  await settle();
  // Exactly one, not merely at least one: the browser appends a final rather
  // than replacing it, so a second copy shows the user's sentence twice.
  const userFinals = rec.user.filter((t) => t.final);
  check('input_audio_transcription.completed emits exactly one FINAL user transcript',
    userFinals.length === 1 && userFinals[0].text === 'Thirty days?', JSON.stringify(rec.user));
  check('the final user transcript is attributed to the open turn',
    rec.user.filter((t) => t.final).every((t) => t.turnId === 1),
    JSON.stringify(rec.user.filter((t) => t.final).map((t) => t.turnId)));

  push({ type: 'response.output_audio_transcript.done', response_id: 'resp_7', item_id: 'msg_7', transcript: 'Our refund window is thirty days.' });
  await settle();
  check('the assistant final carries the whole utterance, not the last fragment',
    rec.assistant.some((t) => t.final && t.text === 'Our refund window is thirty days.'),
    JSON.stringify(rec.assistant.filter((t) => t.final)));

  await session.close();
}

/* ============================== 8. start() ============================== */

{
  let message = '';
  try {
    const s = provider.createSession({
      sessionId: 'selftest-nokey',
      config: { mode: 'realtime', systemPrompt: '', turnDetection: 'server_vad' },
      events: {
        onUserTranscript: () => {}, onAssistantTranscript: () => {}, onAudio: () => {},
        onTurnStart: () => {}, onTurnEnd: () => {}, onMetrics: () => {}, onUsage: () => {},
        onLog: () => {}, onError: () => {},
      },
      // No key, and nothing in process.env may rescue it.
      credentials: { OPENAI_WS_BASE: base },
    });
    await s.start();
  } catch (err) {
    message = (err as Error).message;
  }
  check('start() refuses to connect without a key from ctx.credentials',
    message.includes('OPENAI_API_KEY'), message);
}

/* ============ 9. a stale response.done belongs to nobody ============ */
/*
 * Section 1h covers the easy half — a duplicate `response.done` arriving with
 * NO turn open, where a lookup returns nothing anyway. The half that costs real
 * numbers is a stale one arriving while a NEW turn is open: turn 1 is already
 * billed and retired, so its response id matches nothing, and "fall back to
 * whatever turn is open" then billed turn 2 with turn 1's token counts and
 * ended it before its own audio had arrived. Two turns, one set of numbers,
 * and the live one corrupted.
 */
{
  const { session, rec } = await open();
  const USAGE_8 = {
    total_tokens: 200, input_tokens: 100, output_tokens: 100,
    input_token_details: { text_tokens: 100, audio_tokens: 0, cached_tokens: 0 },
    output_token_details: { text_tokens: 100, audio_tokens: 0 },
  };

  // Turn 1: opened, answered, billed, retired.
  push({ type: 'input_audio_buffer.speech_stopped', event_id: 'e1', audio_end_ms: 100 });
  push({ type: 'response.created', event_id: 'e2', response: { id: 'resp_1' } });
  await settle();
  push({ type: 'response.done', event_id: 'e3', response: { id: 'resp_1', status: 'completed', usage: USAGE_8 } });
  await settle();
  check('turn 1 is billed once', rec.usage.length === 1, `${rec.usage.length}`);

  // Turn 2: open, mid-flight, nothing of its own reported yet.
  push({ type: 'input_audio_buffer.speech_stopped', event_id: 'e4', audio_end_ms: 900 });
  push({ type: 'response.created', event_id: 'e5', response: { id: 'resp_2' } });
  await settle();
  const billed = rec.usage.length;
  const ended = rec.turnEnds.length;

  push({ type: 'response.done', event_id: 'e6', response: { id: 'resp_1', status: 'completed', usage: USAGE_8 } });
  await settle();
  check('a stale response.done does not bill the newly opened turn',
    rec.usage.length === billed, `${billed} -> ${rec.usage.length}`);
  check('...and does not end it early', rec.turnEnds.length === ended, `${ended} -> ${rec.turnEnds.length}`);

  await session.close();
  // Turn 2 DID have a response created, so close() rightly emits a row for it —
  // but it must be its own empty, unpriced row, never a copy of turn 1's counts.
  const two = rec.usage.find((u) => u.turnId === 2)?.legs[0];
  check('turn 2 gets its own row on close', two !== undefined);
  check('...carrying no invented token counts',
    (two?.inputUnits ?? -1) === 0 && (two?.outputUnits ?? -1) === 0,
    `${two?.inputUnits}/${two?.outputUnits}`);
  check('...and marked unpriced rather than free',
    Boolean(two?.unpricedReason), two?.unpricedReason ?? 'none');
}

/* ============ 10. server-VAD barge-in — the one that fires live ============ */
/*
 * Section 2 covers `interrupt()`, which this bench calls only when the client
 * asks it to. The default config here — and in the UI — is `server_vad` with
 * `interrupt_response: true`, so in production the barge-in that actually fires
 * is the vendor's: it cancels its own response and tells us via
 * `input_audio_buffer.speech_started`. Nothing else in this file sends that
 * event, so the handler behind it had no coverage at all.
 */
{
  const { session, rec } = await open();
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u10' });
  push({ type: 'response.created', response: { id: 'resp_10', status: 'in_progress' } });
  const spoken = tone(80);
  push({ type: 'response.output_audio.delta', response_id: 'resp_10', item_id: 'msg_10', delta: spoken.toString('base64') });
  await settle();
  const heard = rec.audio.reduce((n, b) => n + b.length, 0);
  check('the turn is streaming before the user cuts in', heard === spoken.length, `${heard}`);

  push({ type: 'input_audio_buffer.speech_started', audio_end_ms: 1400, item_id: 'item_u11' });
  await settle();
  check('speech_started ends the turn', rec.turnEnds.length === 1 && rec.turnEnds[0] === 1, rec.turnEnds.join(','));
  check('speech_started reports the turn metrics once',
    rec.metrics.length === 1 && rec.metrics[0].turnId === 1, `${rec.metrics.length}`);
  // The vendor has already cancelled the response itself. Sending our own
  // cancel would be a second, racing cancel for a response that is already gone.
  check('no response.cancel is sent for a response the vendor already cancelled',
    sent('response.cancel').length === 0, `${sent('response.cancel').length}`);
  check('speech_started opens no turn of its own (speech_stopped is t0, not this)',
    rec.turnStarts.length === 1, rec.turnStarts.join(','));

  push({ type: 'response.output_audio.delta', response_id: 'resp_10', item_id: 'msg_10', delta: spoken.toString('base64') });
  await settle();
  check('audio still in flight for the cut-off response is not played',
    rec.audio.reduce((n, b) => n + b.length, 0) === heard,
    `${heard} -> ${rec.audio.reduce((n, b) => n + b.length, 0)}`);

  check('nothing is billed until the vendor reports usage', rec.usage.length === 0, `${rec.usage.length}`);
  push({ type: 'response.done', response: { id: 'resp_10', status: 'cancelled', usage: USAGE } });
  await settle();
  check('the cut-off turn is billed exactly once, from vendor counts',
    rec.usage.length === 1 && rec.usage[0].legs[0]?.source === 'vendor', JSON.stringify(rec.usage.length));
  await session.close();
}

/* ================== 11. sendText() — the third t0 site ================== */
/*
 * Typed input has no speech to end, so `sendText` stamps t0 itself at the
 * moment the text is handed over. It is one of only three places a turn can
 * open, and the only one no scenario above touches.
 */
{
  const { session, rec } = await open();
  session.sendText('Where is my order?');
  await settle();

  check('sendText opens exactly one turn', rec.turnStarts.length === 1, rec.turnStarts.join(','));
  const item = sent('conversation.item.create')[0];
  check('the text travels as a user message with an input_text part',
    item?.item?.role === 'user' && item.item.content?.[0]?.type === 'input_text' &&
      item.item.content[0].text === 'Where is my order?',
    JSON.stringify(item?.item));
  check('sendText asks for a response (server VAD only auto-responds to audio)',
    sent('response.create').length === 1, `${sent('response.create').length}`);
  check('the typed text is echoed back as a FINAL user transcript',
    rec.user.length === 1 && rec.user[0].final && rec.user[0].text === 'Where is my order?',
    JSON.stringify(rec.user));
  check('...attributed to the turn sendText just opened',
    rec.user[0]?.turnId === 1, String(rec.user[0]?.turnId));
  check('empty text opens no turn', (session.sendText('   '), rec.turnStarts.length === 1), rec.turnStarts.join(','));

  push({ type: 'response.created', response: { id: 'resp_11', status: 'in_progress' } });
  await settle(120); // the gap TTFA must measure, from the sendText call
  push({ type: 'response.output_audio.delta', response_id: 'resp_11', item_id: 'msg_11', delta: tone(40).toString('base64') });
  push({ type: 'response.done', response: { id: 'resp_11', status: 'completed', usage: USAGE } });
  await settle(120);

  const ttfa = rec.metrics[0]?.derived.timeToFirstAudioMs;
  check('t0 for a typed turn is the sendText call, not the connect',
    ttfa !== undefined && ttfa >= 100 && ttfa < 320, `${ttfa}ms`);
  check('a typed turn is billed exactly once', rec.usage.length === 1, `${rec.usage.length}`);
  await session.close();
}

/* ========== 12. the socket drops with a turn ended but unbilled ========== */
/*
 * `flushBilling` on an unexpected close is the only thing between a dropped
 * socket and a turn vanishing off the invoice. Section 3 reaches it through
 * `close()`, which this process controls; nothing reaches it through the socket
 * dying underneath a turn the vendor has already started metering. Make an
 * abnormal close neither error nor bill and every other check stays green.
 */
{
  const { session, rec } = await open();
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u12' });
  push({ type: 'response.created', response: { id: 'resp_12', status: 'in_progress' } });
  push({ type: 'response.output_audio.delta', response_id: 'resp_12', item_id: 'msg_12', delta: tone(80).toString('base64') });
  await settle();

  // The user talks over it: the turn ends here, but the bill does not — the
  // token counts only arrive with `response.done`.
  session.interrupt();
  await settle();
  check('the interrupted turn is ended but not yet billed',
    rec.turnEnds.length === 1 && rec.usage.length === 0, `${rec.turnEnds.length}/${rec.usage.length}`);

  // ...and the `response.done` never comes, because the socket dies first.
  serverWs?.close(1011, 'upstream gone');
  await settle(200);

  check('an unexpected close is surfaced to the caller',
    rec.errors.some((e) => e.includes('closed unexpectedly')), rec.errors.join('; '));
  check('the dropped socket still bills the turn exactly once',
    rec.usage.length === 1, `${rec.usage.length}`);
  const leg = rec.usage[0]?.legs[0];
  check('a turn the vendor never costed is not reported as a measurement',
    leg?.source === 'local', String(leg?.source));
  check('...and says why it is unpriced, so the session total reads as a floor',
    (leg?.unpricedReason ?? '').includes('socket closed'), leg?.unpricedReason ?? 'none');
  check('the dropped socket invents no token counts',
    leg?.inputUnits === 0 && leg.outputUnits === 0,
    JSON.stringify({ in: leg?.inputUnits, out: leg?.outputUnits }));

  await session.close();
  check('closing after a socket drop adds no second row', rec.usage.length === 1, `${rec.usage.length}`);
}

/* ============ 13. the session boundary rate is read, not assumed ============ */
/*
 * Every scenario above runs at CANONICAL_SAMPLE_RATE, where both
 * `resamplePcm16` calls are no-ops — delete them outright and the suite stays
 * green. The invariant is that a provider converts against the rate it was
 * given rather than the constant, so it stays correct if the boundary moves.
 *
 * A realtime session takes no per-session rate the way `TtsOptions` does, so
 * the only way to move the boundary is to move the field the provider reads.
 * That is the point: if the module were reading the constant instead, this
 * would change nothing and both checks below would fail.
 */
{
  const { session, rec } = await open();
  (session as unknown as { sessionRate: number }).sessionRate = 16000;

  // Up: 16 kHz mic audio must reach OpenAI at the 24 kHz its format demands.
  const mic = tone(60, 220, 16000); // 960 samples = 1920 bytes
  session.pushAudio(mic);
  await settle();
  const appended = sent('input_audio_buffer.append').at(-1);
  const upBytes = appended ? Buffer.from(appended.audio, 'base64').length : 0;
  check('mic audio is resampled UP from the boundary rate to the vendor\'s 24kHz',
    upBytes === Math.floor((mic.length / 2) * (24000 / 16000)) * 2,
    `${upBytes} bytes from ${mic.length}`);

  // Down: the vendor's 24 kHz audio must reach the sink at the boundary rate.
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u13' });
  push({ type: 'response.created', response: { id: 'resp_13', status: 'in_progress' } });
  const spoken = tone(60); // 1440 samples @ 24kHz = 2880 bytes
  push({ type: 'response.output_audio.delta', response_id: 'resp_13', item_id: 'msg_13', delta: spoken.toString('base64') });
  await settle();
  const downBytes = rec.audio.reduce((n, b) => n + b.length, 0);
  check('vendor audio is resampled DOWN to the boundary rate before the sink',
    downBytes === Math.floor((spoken.length / 2) * (16000 / 24000)) * 2,
    `${downBytes} bytes from ${spoken.length}`);

  // 1440 samples at 24kHz is 60ms and stays 60ms at 16kHz. Durations are read
  // through the boundary rate too, so a moved boundary must not restate the
  // length of the audio — which is what `conversation.item.truncate` and the
  // usage row's `audioSeconds` are both built on.
  session.interrupt();
  await settle();
  check('the truncate point is a DURATION, unchanged by the boundary rate',
    sent('conversation.item.truncate')[0]?.audio_end_ms === 60,
    String(sent('conversation.item.truncate')[0]?.audio_end_ms));

  push({ type: 'response.done', response: { id: 'resp_13', status: 'cancelled', usage: USAGE } });
  await settle();
  check('audioSeconds is likewise unchanged by the boundary rate',
    Math.abs((rec.usage[0]?.legs[0]?.audioSeconds ?? 0) - 0.06) < 0.005,
    String(rec.usage[0]?.legs[0]?.audioSeconds));

  check('the format asked of the vendor does NOT follow the boundary',
    JSON.stringify(sentSession().audio?.output?.format) === JSON.stringify({ type: 'audio/pcm', rate: 24000 }),
    JSON.stringify(sentSession().audio?.output?.format));

  await session.close();
}

/* ============ 14. a frame that is not JSON must not take the session down ============ */
/*
 * Every frame the fake sends is well-formed by construction, so the parse guard
 * in `onMessage` is never reached: remove it and the suite stays green while a
 * single proxy error page throws inside the socket callback, unhandled.
 */
{
  const { session, rec } = await open();
  push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_u14' });
  pushRaw('<html><body>502 Bad Gateway</body></html>');
  await settle();
  check('a non-JSON frame raises no error of its own', rec.errors.length === 0, rec.errors.join('; '));

  push({ type: 'response.created', response: { id: 'resp_14', status: 'in_progress' } });
  pushRaw('{"type":"response.output_audio.delta",');  // truncated mid-object
  const spoken = tone(40);
  push({ type: 'response.output_audio.delta', response_id: 'resp_14', item_id: 'msg_14', delta: spoken.toString('base64') });
  push({ type: 'response.done', response: { id: 'resp_14', status: 'completed', usage: USAGE } });
  await settle(120);

  check('the events after a malformed frame are still handled',
    rec.audio.reduce((n, b) => n + b.length, 0) === spoken.length,
    `${rec.audio.reduce((n, b) => n + b.length, 0)}`);
  check('the turn still ends and bills exactly once',
    rec.turnEnds.length === 1 && rec.usage.length === 1, `${rec.turnEnds.length}/${rec.usage.length}`);
  await session.close();
}

/* ------------------------------- report ------------------------------- */

let failed = 0;
for (const [n, ok, d] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !d ? '' : `  -> ${d}`}`);
  if (!ok) failed += 1;
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
wss.close();
process.exit(failed ? 1 : 0);
