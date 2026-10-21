/**
 * OpenAiRealtimeProvider against a local WebSocket fake of /v1/realtime.
 *
 * The fake accepts anything; a green run proves this module's wire building,
 * event handling, turn attribution and billing — not what OpenAI accepts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiRealtimeProvider } from '../../../src/providers/realtime/OpenAiRealtimeProvider.js';
import type { VoiceSession } from '../../../src/providers/types.js';
import type { StartConfig } from '../../../src/shared/protocol.js';
import { silence, tone } from '../../../src/audio/pcm.js';
import { deadPort, flushIo, markOf, ramp, recorder, startWs, waitFor, type FakeWs, type Json, type Recorder } from './helpers.js';

const KEY = 'test-key-XYZ-realtime';

let fake: FakeWs;
/** When true the fake acknowledges session.update the way OpenAI does. */
let autoAck = true;
const sessions: VoiceSession[] = [];

beforeEach(async () => {
  autoAck = true;
  fake = await startWs({ path: '/v1/realtime' });
  fake.onMessage((msg, ws) => {
    if (autoAck && msg.type === 'session.update') {
      ws.send(JSON.stringify({ type: 'session.created', session: {} }));
      ws.send(JSON.stringify({ type: 'session.updated', session: msg.session }));
    }
  });
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await fake.close();
});

function create(config: Partial<StartConfig> = {}, credentials?: Record<string, string | undefined>): { session: VoiceSession; rec: Recorder } {
  const rec = recorder();
  const session = new OpenAiRealtimeProvider().createSession({
    sessionId: 'rt-test',
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
    events: rec.events,
    credentials: credentials ?? { OPENAI_API_KEY: KEY, OPENAI_WS_BASE: fake.url },
  });
  sessions.push(session);
  return { session, rec };
}

async function open(config: Partial<StartConfig> = {}): Promise<{ session: VoiceSession; rec: Recorder }> {
  const made = create(config);
  await made.session.start();
  return made;
}

const sentSession = (): Json => fake.received.find((m) => m.type === 'session.update')?.session ?? {};
const sent = (type: string): Json[] => fake.received.filter((m) => m.type === type);
const b64 = (b: Buffer) => b.toString('base64');

/**
 * Client -> server ordering barrier: a silent mic frame of a length no other
 * frame here has. Returns its index in `fake.received`; everything before that
 * index was sent before the barrier.
 */
let clientSeq = 0;
async function barrier(session: VoiceSession): Promise<number> {
  const ms = 101 + (++clientSeq % 50);
  const expected = ms * 24 * 2;
  session.pushAudio(silence(ms));
  const find = () =>
    fake.received.findIndex(
      (m) => m.type === 'input_audio_buffer.append' && Buffer.from(m.audio, 'base64').length === expected,
    );
  await waitFor(() => find() !== -1, 'client barrier');
  return find();
}

/** OpenAI's documented usage example, with a non-zero cached-audio split. */
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

/** Opens a server-VAD turn and starts response `rid` streaming one audio delta. */
async function startTurn(rec: Recorder, rid: string, item: string, audio: Buffer = tone(40), expectBytes = audio.length): Promise<void> {
  const turnsBefore = rec.turnStarts.length;
  const bytesBefore = rec.audioBytes();
  fake.push({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000, item_id: 'item_user' });
  fake.push({ type: 'response.created', response: { id: rid, status: 'in_progress' } });
  fake.push({ type: 'response.output_audio.delta', response_id: rid, item_id: item, delta: b64(audio) });
  await waitFor(() => rec.turnStarts.length === turnsBefore + 1 && rec.audioBytes() === bytesBefore + expectBytes, 'turn audio');
}

const noSecret = (rec: Recorder) => expect(rec.everything()).not.toContain(KEY);

/* ======================================================================== */

describe('OpenAI Realtime — connection and session.update', () => {
  it('authenticates with a bearer header, model in the query, key never in the URL, no beta header', async () => {
    await open();
    const conn = fake.connections[0];
    expect(conn.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(conn.url).toBe('/v1/realtime?model=gpt-realtime-2.1');
    expect(conn.url).not.toContain(KEY);
    expect(conn.headers['openai-beta']).toBeUndefined();
  });

  it('appends model with & when the base already carries a query string', async () => {
    const { session } = create({}, { OPENAI_API_KEY: KEY, OPENAI_WS_BASE: `${fake.url}?trace=1` });
    await session.start();
    expect(fake.connections[0].url).toBe('/v1/realtime?trace=1&model=gpt-realtime-2.1');
  });

  it('sends exactly the nested GA session shape', async () => {
    await open();
    expect(fake.received[0].type).toBe('session.update');
    expect(sentSession()).toEqual({
      type: 'realtime',
      model: 'gpt-realtime-2.1',
      output_modalities: ['audio'],
      instructions: 'Speak clearly and briefly.',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-transcribe', language: 'en' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'cedar' },
      },
    });
  });

  it('strips the @variant from the wire model and sends it as reasoning.effort', async () => {
    await open({ realtimeModelId: 'gpt-realtime-2.1-mini@low' });
    expect(fake.connections[0].url).toBe('/v1/realtime?model=gpt-realtime-2.1-mini');
    expect(sentSession().model).toBe('gpt-realtime-2.1-mini');
    expect(sentSession().reasoning).toEqual({ effort: 'low' });
  });

  it('defaults the model and the voice when the config leaves them blank', async () => {
    const { session } = await open({ realtimeModelId: undefined, voice: '   ' });
    expect(session.label).toBe('openai-realtime:gpt-realtime-2.1');
    expect(sentSession().audio.output.voice).toBe('marin');
  });

  it('a non-built-in voice is sent as a custom {id} object', async () => {
    await open({ voice: 'voice_abc123' });
    expect(sentSession().audio.output.voice).toEqual({ id: 'voice_abc123' });
  });

  it.each([
    ['hi-IN', 'hi'],
    ['ta', 'ta'],
  ])('language %s is narrowed to ISO-639-1 %s for transcription', async (lang, iso) => {
    await open({ language: lang });
    expect(sentSession().audio.input.transcription).toEqual({ model: 'gpt-transcribe', language: iso });
  });

  it('no language sends no language key at all', async () => {
    await open({ language: undefined });
    expect(sentSession().audio.input.transcription).toEqual({ model: 'gpt-transcribe' });
  });

  it('manual turn detection sends turn_detection: null', async () => {
    await open({ turnDetection: 'manual' });
    expect(sentSession().audio.input.turn_detection).toBeNull();
  });

  it('start() waits for session.updated — session.created alone does not resolve it', async () => {
    autoAck = false;
    const { session, rec } = create();
    let resolved = false;
    const started = session.start().then(() => (resolved = true));
    await waitFor(() => sent('session.update').length === 1, 'session.update');
    fake.push({ type: 'session.created', session: {} });
    await serverBarrier(rec);
    expect(resolved).toBe(false);
    fake.push({ type: 'session.updated', session: {} });
    await started;
    expect(resolved).toBe(true);
  });

  it('a server error during the handshake rejects start(), reports it, and closes the socket', async () => {
    autoAck = false;
    const { session, rec } = create();
    const started = session.start();
    await waitFor(() => sent('session.update').length === 1, 'session.update');
    fake.push({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Invalid voice' } });
    await expect(started).rejects.toThrow('OpenAI Realtime rejected the session: Invalid voice');
    expect(rec.errors.map((e) => e.message)).toEqual(['OpenAI Realtime invalid_value: Invalid voice']);
    await waitFor(() => fake.closedSockets === 1, 'socket closed');
    noSecret(rec);
  });

  it('the server closing during the handshake rejects start() with the close code and reason', async () => {
    autoAck = false;
    fake.onMessage((msg, ws) => {
      if (msg.type === 'session.update') ws.close(4001, 'policy');
    });
    const { session, rec } = create();
    await expect(session.start()).rejects.toThrow('OpenAI Realtime closed during handshake (4001: policy)');
    expect(rec.errors).toEqual([]);
  });

  it('an HTTP 401 at upgrade rejects start() without leaking the key, and raises no second error', async () => {
    await fake.close();
    fake = await startWs({
      path: '/v1/realtime',
      verifyClient: (_info, cb) => cb(false, 401, 'Unauthorized'),
    });
    const { session, rec } = create({}, { OPENAI_API_KEY: KEY, OPENAI_WS_BASE: fake.url });
    const err = await session.start().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toContain('401');
    expect(err?.message).not.toContain(KEY);
    expect(err?.stack ?? '').not.toContain(KEY);
    await flushIo();
    expect(rec.errors).toEqual([]);
  });

  it('a refused connection rejects start() without the key', async () => {
    const port = await deadPort();
    const { session, rec } = create({}, { OPENAI_API_KEY: KEY, OPENAI_WS_BASE: `ws://127.0.0.1:${port}/v1/realtime` });
    const err = await session.start().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/^OpenAI Realtime socket: /);
    expect(err?.message).not.toContain(KEY);
    await flushIo();
    expect(rec.errors).toEqual([]);
  });

  it('reads the key only from ctx.credentials: a key in process.env is not used', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key-must-not-be-used');
    vi.stubEnv('OPENAI_WS_BASE', fake.url);
    const { session } = create({}, {});
    await expect(session.start()).rejects.toThrow('OPENAI_API_KEY is not set');
    expect(fake.connections).toHaveLength(0);
  });

  it('close() while the handshake is pending rejects start() and raises no error event', async () => {
    autoAck = false;
    const { session, rec } = create();
    const started = session.start().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await waitFor(() => sent('session.update').length === 1, 'session.update');
    await session.close();
    expect(await started).not.toBe('resolved');
    await flushIo();
    expect(rec.errors).toEqual([]);
  });
});

/**
 * Ordering barrier for server -> client: pushes a frame with a harmless,
 * observable effect (a warn log) and waits for it. One socket, in order, so
 * every frame pushed before it has been handled once it lands.
 */
let barrierSeq = 0;
async function serverBarrier(rec: Recorder): Promise<void> {
  const tag = `__barrier_${++barrierSeq}__`;
  fake.push({ type: 'conversation.item.input_audio_transcription.failed', error: { message: tag } });
  await waitFor(() => rec.logs.some((l) => l.includes(tag)), 'server barrier');
}

describe('OpenAI Realtime — audio at the boundary', () => {
  it('forwards each mic frame as its own base64 append, unchanged at 24 kHz', async () => {
    const { session } = await open();
    const a = ramp(240);
    const b = ramp(480, 3);
    session.pushAudio(a);
    session.pushAudio(b);
    await waitFor(() => sent('input_audio_buffer.append').length === 2, 'appends');
    const [first, second] = sent('input_audio_buffer.append');
    expect(Buffer.from(first.audio, 'base64').equals(a)).toBe(true);
    expect(Buffer.from(second.audio, 'base64').equals(b)).toBe(true);
  });

  it('drops empty mic frames', async () => {
    const { session } = await open();
    session.pushAudio(Buffer.alloc(0));
    await barrier(session);
    expect(sent('input_audio_buffer.append')).toHaveLength(1);
  });

  it('vendor audio is emitted at 24 kHz byte-for-byte, as soon as each delta arrives', async () => {
    const { rec } = await open();
    const first = ramp(1200);
    await startTurn(rec, 'r1', 'msg1', first);
    expect(rec.audio).toHaveLength(1);
    expect(rec.audio[0].equals(first)).toBe(true);
    const second = ramp(600, 11);
    fake.push({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'msg1', delta: b64(second) });
    await waitFor(() => rec.audio.length === 2, 'second delta');
    expect(rec.audio[1].equals(second)).toBe(true);
  });

  it('resamples against the session rate, not the constant: 16 kHz boundary -> 24 kHz up, 24 kHz -> 16 kHz down', async () => {
    const { session, rec } = create();
    (session as unknown as { sessionRate: number }).sessionRate = 16000;
    await session.start();

    session.pushAudio(ramp(160)); // 10ms at 16k
    await waitFor(() => sent('input_audio_buffer.append').length === 1, 'append');
    expect(Buffer.from(sent('input_audio_buffer.append')[0].audio, 'base64').length).toBe(240 * 2);

    await startTurn(rec, 'r1', 'msg1', ramp(480), 320 * 2); // 20ms at 24k -> 320 samples at 16k
    expect(rec.audio[0].length).toBe(320 * 2);

    // truncate's audio_end_ms is the forwarded duration at the SESSION rate: 320 samples @16k = 20ms.
    session.interrupt();
    await waitFor(() => sent('conversation.item.truncate').length === 1, 'truncate');
    expect(sent('conversation.item.truncate')[0].audio_end_ms).toBe(20);

    fake.push({ type: 'response.done', response: { id: 'r1', status: 'cancelled', usage: USAGE } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    expect(rec.usage[0].legs[0].audioSeconds).toBe(0.02);
  });

  it('an empty or missing audio delta emits nothing and marks nothing', async () => {
    const { rec } = await open();
    fake.push({ type: 'input_audio_buffer.speech_stopped' });
    fake.push({ type: 'response.created', response: { id: 'r1' } });
    fake.push({ type: 'response.output_audio.delta', response_id: 'r1', delta: '' });
    fake.push({ type: 'response.output_audio.delta', response_id: 'r1' });
    fake.push({ type: 'response.done', response: { id: 'r1', status: 'completed', usage: USAGE } });
    await waitFor(() => rec.metrics.length === 1, 'metrics');
    expect(rec.audio).toEqual([]);
    expect(markOf(rec.metrics[0].marks, 'first_audio_out')).toBeUndefined();
  });
});

describe('OpenAI Realtime — a normal turn', () => {
  it('t0 is speech_stopped; first audio, transcripts and usage land on that turn', async () => {
    const { rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    fake.push({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_user', delta: 'What is ' });
    fake.push({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_user', delta: 'the time?' });
    fake.push({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_user', transcript: 'What is the time?' });
    fake.push({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'It is ' });
    fake.push({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'noon.' });
    fake.push({ type: 'response.output_audio_transcript.done', response_id: 'r1', transcript: 'It is noon.' });
    fake.push({ type: 'response.output_audio.done', response_id: 'r1' });
    fake.push({ type: 'response.done', response: { id: 'r1', status: 'completed', usage: USAGE } });
    await waitFor(() => rec.usage.length === 1, 'usage');

    expect(rec.turnStarts).toEqual([1]);
    expect(rec.turnEnds).toEqual([1]);
    // Cumulative, not fragments.
    expect(rec.user).toEqual([
      { text: 'What is ', final: false, turnId: 1 },
      { text: 'What is the time?', final: false, turnId: 1 },
      { text: 'What is the time?', final: true, turnId: 1 },
    ]);
    expect(rec.assistant).toEqual([
      { text: 'It is ', final: false, turnId: 1 },
      { text: 'It is noon.', final: false, turnId: 1 },
      { text: 'It is noon.', final: true, turnId: 1 },
    ]);

    const { marks, derived } = rec.metrics[0];
    expect(markOf(marks, 'user_speech_end')).toBeLessThan(5);
    for (const m of ['first_audio_out', 'stt_first_partial', 'stt_final', 'last_audio_out'] as const) {
      expect(markOf(marks, m)).toBeGreaterThanOrEqual(0);
    }
    // Derived numbers are measured FROM user_speech_end.
    const t0 = markOf(marks, 'user_speech_end')!;
    expect(Math.abs(derived.timeToFirstAudioMs! - (markOf(marks, 'first_audio_out')! - t0))).toBeLessThanOrEqual(0.2);
    expect(Math.abs(derived.sttLatencyMs! - (markOf(marks, 'stt_final')! - t0))).toBeLessThanOrEqual(0.2);
  });

  it('bills one realtime row in tokens with the audio/text split and the catalog model id', async () => {
    const { rec } = await open({ realtimeModelId: 'gpt-realtime-2.1@low' });
    await startTurn(rec, 'r1', 'msg1', tone(100));
    fake.push({ type: 'response.done', response: { id: 'r1', status: 'completed', usage: USAGE } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    expect(rec.usage[0]).toEqual({
      turnId: 1,
      legs: [
        {
          leg: 'realtime',
          providerId: 'openai-realtime',
          modelId: 'gpt-realtime-2.1@low',
          unit: 'tokens',
          inputUnits: 132,
          outputUnits: 121,
          cachedInputTokens: 64,
          audioInputTokens: 53,
          audioOutputTokens: 91,
          cachedAudioInputTokens: 40,
          audioSeconds: 0.1,
          source: 'vendor',
        },
      ],
    });
    const leg = rec.usage[0].legs[0];
    // Every breakdown sits inside its total.
    expect(leg.audioInputTokens!).toBeLessThanOrEqual(leg.inputUnits);
    expect(leg.cachedInputTokens!).toBeLessThanOrEqual(leg.inputUnits);
    expect(leg.cachedAudioInputTokens!).toBeLessThanOrEqual(Math.min(leg.cachedInputTokens!, leg.audioInputTokens!));
    expect(leg.audioOutputTokens!).toBeLessThanOrEqual(leg.outputUnits);
  });

  it('a response.done with no usage is billed as unpriced/local with no invented counts', async () => {
    const { rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    fake.push({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    const leg = rec.usage[0].legs[0];
    expect(leg).toMatchObject({ source: 'local', inputUnits: 0, outputUnits: 0 });
    expect(leg.unpricedReason).toBe('OpenAI Realtime reported no usage for this turn');
  });

  it('a duplicate response.done bills once; a late one for a retired id does not touch the next turn', async () => {
    const { rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    fake.push({ type: 'response.done', response: { id: 'r1', usage: USAGE } });
    fake.push({ type: 'response.done', response: { id: 'r1', usage: USAGE } });
    await startTurn(rec, 'r2', 'msg2');
    fake.push({ type: 'response.done', response: { id: 'r1', usage: { input_tokens: 999, output_tokens: 999 } } });
    await serverBarrier(rec);
    expect(rec.usage).toHaveLength(1);
    expect(rec.turnEnds).toEqual([1]); // turn 2 is still open
    fake.push({ type: 'response.done', response: { id: 'r2', usage: { input_tokens: 5, output_tokens: 6 } } });
    await waitFor(() => rec.usage.length === 2, 'turn 2 usage');
    expect(rec.usage[1]).toMatchObject({ turnId: 2, legs: [{ inputUnits: 5, outputUnits: 6 }] });
  });

  it('response.created with no turn open opens one and says t0 is the response start', async () => {
    const { rec } = await open();
    fake.push({ type: 'response.created', response: { id: 'r1' } });
    await waitFor(() => rec.turnStarts.length === 1, 'turn');
    expect(rec.logs.some((l) => l.startsWith('warn:') && l.includes('no turn open'))).toBe(true);
  });

  it('a delta from a superseded response is dropped, not played on the new turn', async () => {
    const { session, rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    session.sendText('actually, something else');
    fake.push({ type: 'response.created', response: { id: 'r2' } });
    fake.push({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'msg1', delta: b64(tone(40)) });
    fake.push({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'stale words' });
    await serverBarrier(rec);
    expect(rec.audio).toHaveLength(1);
    expect(rec.assistant.some((a) => a.text.includes('stale'))).toBe(false);
    expect(markOf(rec.metrics.at(-1)?.marks, 'first_audio_out')).toBeDefined(); // turn 1's own
    fake.push({ type: 'response.output_audio.delta', response_id: 'r2', item_id: 'msg2', delta: b64(tone(20)) });
    await waitFor(() => rec.audio.length === 2, 'r2 audio');
  });

  it('a non-JSON frame and unknown events are ignored without error', async () => {
    const { rec } = await open();
    fake.pushRaw('not json {');
    fake.push({ type: 'conversation.item.created', item: {} });
    fake.push({ type: 'input_audio_buffer.committed' });
    await startTurn(rec, 'r1', 'msg1');
    expect(rec.errors).toEqual([]);
  });

  it('an in-session error event is surfaced and the session keeps working', async () => {
    const { session, rec } = await open();
    fake.push({ type: 'error', error: { type: 'invalid_request_error', code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } });
    await waitFor(() => rec.errors.length === 1, 'error');
    expect(rec.errors[0].message).toBe('OpenAI Realtime input_audio_buffer_commit_empty: buffer too small');
    session.sendText('still there?');
    await waitFor(() => sent('response.create').length === 1, 'response.create');
    noSecret(rec);
  });

  it('a failed input transcription is logged as a warning, not an error', async () => {
    const { rec } = await open();
    fake.push({ type: 'conversation.item.input_audio_transcription.failed', error: { message: 'asr down' } });
    await waitFor(() => rec.logs.length === 1, 'log');
    expect(rec.logs[0]).toBe('warn: OpenAI Realtime input transcription failed: asr down');
    expect(rec.errors).toEqual([]);
  });
});

describe('OpenAI Realtime — input paths', () => {
  it('sendText opens a turn, echoes a final user line, and sends item.create + response.create', async () => {
    const { session, rec } = await open();
    session.sendText('hello there');
    await waitFor(() => sent('response.create').length === 1, 'response.create');
    expect(rec.turnStarts).toEqual([1]);
    expect(rec.user).toEqual([{ text: 'hello there', final: true, turnId: 1 }]);
    expect(sent('conversation.item.create')[0].item).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello there' }],
    });
    const types = fake.received.map((m) => m.type);
    expect(types.indexOf('conversation.item.create')).toBeLessThan(types.indexOf('response.create'));
  });

  it('whitespace-only text sends nothing and opens no turn', async () => {
    const { session, rec } = await open();
    session.sendText('   ');
    const n = await barrier(session);
    expect(fake.received.slice(0, n).some((m) => m.type === 'conversation.item.create')).toBe(false);
    expect(rec.turnStarts).toEqual([]);
  });

  it('manual mode: commitAudio stamps t0 and sends commit then response.create', async () => {
    const { session, rec } = await open({ turnDetection: 'manual' });
    session.pushAudio(tone(200));
    session.commitAudio();
    await waitFor(() => sent('response.create').length === 1, 'response.create');
    expect(rec.turnStarts).toEqual([1]);
    const types = fake.received.map((m) => m.type);
    expect(types.slice(-3)).toEqual(['input_audio_buffer.append', 'input_audio_buffer.commit', 'response.create']);
  });

  it('server-VAD mode: commitAudio sends nothing (the server commits itself)', async () => {
    const { session, rec } = await open();
    session.commitAudio();
    const n = await barrier(session);
    expect(fake.received.slice(0, n).map((m) => m.type)).toEqual(['session.update']);
    expect(rec.turnStarts).toEqual([]);
  });

  it('a manual commit that never produces a response is not billed, only logged', async () => {
    const { session, rec } = await open({ turnDetection: 'manual' });
    session.commitAudio();
    await waitFor(() => sent('response.create').length === 1, 'response.create');
    fake.push({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'too small' } });
    await waitFor(() => rec.errors.length === 1, 'error');
    await session.close();
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toEqual([]);
    expect(rec.logs.some((l) => l.includes('turn 1 produced no response and was not billed'))).toBe(true);
  });
});

describe('OpenAI Realtime — barge-in', () => {
  it('interrupt() sends response.cancel + item.truncate, raises onInterrupt once, drops later audio, and still bills', async () => {
    const { session, rec } = await open();
    const audio = tone(120); // 2880 samples = 120ms
    await startTurn(rec, 'r1', 'msg1', audio);

    session.interrupt();
    expect(rec.interrupts).toBe(1);
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toEqual([]); // billing waits for response.done

    await waitFor(() => sent('conversation.item.truncate').length === 1, 'truncate');
    expect(sent('response.cancel')).toEqual([{ type: 'response.cancel', response_id: 'r1' }]);
    expect(sent('conversation.item.truncate')[0]).toEqual({
      type: 'conversation.item.truncate',
      item_id: 'msg1',
      content_index: 0,
      audio_end_ms: 120,
    });
    const types = fake.received.map((m) => m.type);
    expect(types.indexOf('response.cancel')).toBeLessThan(types.indexOf('conversation.item.truncate'));
    // Not sent over a WebSocket — WebRTC/SIP only.
    expect(sent('output_audio_buffer.clear')).toEqual([]);

    fake.push({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'msg1', delta: b64(tone(40)) });
    fake.push({ type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: 'late words' });
    fake.push({ type: 'response.done', response: { id: 'r1', status: 'cancelled', usage: USAGE } });
    await waitFor(() => rec.usage.length === 1, 'usage after cancel');
    expect(rec.audio).toHaveLength(1);
    expect(rec.usage[0].legs[0].source).toBe('vendor');
    expect(rec.usage[0].legs[0].audioSeconds).toBe(0.12);

    session.interrupt(); // no turn open now
    const n = await barrier(session);
    expect(fake.received.slice(0, n).filter((m) => m.type === 'response.cancel')).toHaveLength(1);
    expect(rec.interrupts).toBe(1);
  });

  it('interrupt() before any audio sends cancel without truncate and raises no onInterrupt', async () => {
    const { session, rec } = await open();
    fake.push({ type: 'input_audio_buffer.speech_stopped' });
    await waitFor(() => rec.turnStarts.length === 1, 'turn');
    session.interrupt();
    const n = await barrier(session);
    const before = fake.received.slice(0, n).map((m) => m.type);
    expect(before.filter((t) => t === 'response.cancel')).toHaveLength(1);
    expect(sent('response.cancel')[0]).toEqual({ type: 'response.cancel' }); // no response id known yet
    expect(before).not.toContain('conversation.item.truncate');
    expect(rec.interrupts).toBe(0);
  });

  it('server-VAD speech_started ends the turn locally and sends NO response.cancel', async () => {
    const { session, rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    fake.push({ type: 'input_audio_buffer.speech_started' });
    await waitFor(() => rec.turnEnds.length === 1, 'turn end');
    const n = await barrier(session);
    expect(fake.received.slice(0, n).some((m) => m.type === 'response.cancel')).toBe(false);
    fake.push({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'msg1', delta: b64(tone(20)) });
    fake.push({ type: 'response.done', response: { id: 'r1', status: 'cancelled', usage: USAGE } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    expect(rec.audio).toHaveLength(1);
  });
});

describe('OpenAI Realtime — teardown', () => {
  it('close() ends and bills an in-flight turn once (unpriced), closes the socket, and is idempotent', async () => {
    const { session, rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    await session.close();
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0].legs[0]).toMatchObject({ source: 'local', inputUnits: 0, outputUnits: 0 });
    expect(rec.usage[0].legs[0].unpricedReason).toBe('session closed before the vendor reported usage');
    await waitFor(() => fake.closedSockets === 1, 'server saw close');

    await session.close();
    session.pushAudio(tone(20));
    session.sendText('after close');
    session.commitAudio();
    session.interrupt();
    expect(rec.usage).toHaveLength(1);
    expect(rec.turnStarts).toEqual([1]);
    expect(rec.errors).toEqual([]);
  });

  it('close() does not re-bill a turn already billed', async () => {
    const { session, rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    fake.push({ type: 'response.done', response: { id: 'r1', usage: USAGE } });
    await waitFor(() => rec.usage.length === 1, 'usage');
    await session.close();
    expect(rec.usage).toHaveLength(1);
  });

  it('an unexpected server close after barge-in bills the awaiting turn as unpriced, once', async () => {
    const { session, rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    session.interrupt();
    fake.socket().close(1011, 'upstream gone');
    await waitFor(() => rec.usage.length === 1, 'flush on close');
    expect(rec.errors.map((e) => e.message)).toEqual(['OpenAI Realtime closed unexpectedly (1011: upstream gone)']);
    expect(rec.usage[0].legs[0].unpricedReason).toBe('socket closed before the vendor reported usage');
    await session.close();
    expect(rec.usage).toHaveLength(1);
    expect(rec.errors).toHaveLength(1);
    noSecret(rec);
  });

  /*
   * Was a bug: an unexpected close only flushed `awaitingUsage`, leaving the
   * ACTIVE turn open and unbilled until a later close() (mislabelled "session
   * closed before…"). The ws 'close' handler now marks the session closed, ends
   * the active turn and bills it as "socket closed before…", as Nova's
   * onStreamClosed does.
   */
  it('an unexpected server close mid-answer ends and bills the in-flight turn at once', async () => {
    const { rec } = await open();
    await startTurn(rec, 'r1', 'msg1');
    fake.socket().close(1011, 'upstream gone');
    await waitFor(() => rec.errors.length === 1, 'error');
    await flushIo();
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toHaveLength(1);
    expect(rec.usage[0].legs[0].unpricedReason).toContain('socket closed');
  });

  /*
   * Was a bug: onMessage had no `closed` guard, so frames already in flight when
   * close() ran opened a new turn and emitted audio afterwards. onMessage now
   * ignores everything once the session is closed (as Nova's onEvent does).
   * Repro: server answers an append with speech_stopped + response.created + an
   * audio delta; client calls pushAudio() then close() in the same tick.
   */
  it('no session events are emitted after close() has resolved', async () => {
    fake.onMessage((msg, ws) => {
      if (msg.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
      if (msg.type === 'input_audio_buffer.append') {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
        ws.send(JSON.stringify({ type: 'response.created', response: { id: 'r9' } }));
        ws.send(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r9', delta: b64(tone(20)) }));
      }
    });
    const { session, rec } = create();
    await session.start();
    session.pushAudio(tone(20));
    await session.close();
    await waitFor(() => fake.closedSockets === 1, 'socket closed');
    await flushIo();
    expect(rec.turnStarts).toEqual([]);
    expect(rec.audio).toEqual([]);
  });
});
