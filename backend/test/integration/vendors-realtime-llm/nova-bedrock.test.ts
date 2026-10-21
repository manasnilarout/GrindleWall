/**
 * NovaSonicProvider through its REAL transport — the AWS SDK's
 * InvokeModelWithBidirectionalStreamCommand over NodeHttp2Handler — pointed at
 * a local cleartext HTTP/2 server via the `BEDROCK_ENDPOINT` credential.
 *
 * The fake decodes and encodes `application/vnd.amazon.eventstream` with an
 * independent implementation (helpers.ts), so this exercises SigV4 signing,
 * HTTP/2 framing, event-stream encoding and the SDK's output-union decoding the
 * way the WebSocket stand-in in nova-sonic.test.ts cannot.
 *
 * STILL NOT VENDOR EVIDENCE: nothing here says Bedrock accepts any of these
 * events, and the error/exception framing is written from the event-stream
 * spec, not captured from AWS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NovaSonicProvider } from '../../../src/providers/realtime/NovaSonicProvider.js';
import type { VoiceSession } from '../../../src/providers/types.js';
import type { StartConfig } from '../../../src/shared/protocol.js';
import { silence, tone } from '../../../src/audio/pcm.js';
import {
  bedrockChunk,
  bedrockException,
  encodeEventStream,
  flushIo,
  ramp,
  recorder,
  startBedrock,
  waitFor,
  type FakeBedrock,
  type Json,
  type Recorder,
} from './helpers.js';

const ID = 'AKIATESTXYZBEDROCK';
const SECRET = 'test-secret-XYZ-bedrock/abc+def';
const TOKEN = 'test-session-token-XYZ';

let fake: FakeBedrock;
const sessions: VoiceSession[] = [];

beforeEach(async () => {
  // The SDK's retry middleware console.warns once per failed streaming request.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = await startBedrock();
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await fake.close();
});

function create(
  extraCreds: Record<string, string | undefined> = {},
  config: Partial<StartConfig> = {},
): { session: VoiceSession; rec: Recorder } {
  const rec = recorder();
  const session = new NovaSonicProvider().createSession({
    sessionId: 'nova-h2',
    config: {
      mode: 'realtime',
      realtimeProviderId: 'aws-nova-sonic',
      realtimeModelId: 'amazon.nova-2-sonic-v1:0',
      systemPrompt: 'Be brief.',
      language: 'en-GB',
      voice: 'amy',
      turnDetection: 'manual',
      ...config,
    },
    events: rec.events,
    credentials: {
      AWS_ACCESS_KEY_ID: ID,
      AWS_SECRET_ACCESS_KEY: SECRET,
      AWS_REGION: 'ap-northeast-1',
      BEDROCK_ENDPOINT: fake.endpoint,
      ...extraCreds,
    },
  });
  sessions.push(session);
  return { session, rec };
}

const nameOf = (e: Json) => Object.keys(e.event ?? {})[0] ?? '?';
const PREAMBLE = ['sessionStart', 'promptStart', 'contentStart', 'textInput', 'contentEnd', 'contentStart'];

async function openOk(extraCreds: Record<string, string | undefined> = {}, config: Partial<StartConfig> = {}) {
  const made = create(extraCreds, config);
  await made.session.start();
  await waitFor(() => fake.requests.length === 1 && fake.requests[0].events.length >= PREAMBLE.length, 'preamble over h2');
  return { ...made, req: fake.requests[0] };
}

const secretFree = (s: string) => {
  expect(s).not.toContain(SECRET);
  expect(s).not.toContain(TOKEN);
};

describe('Nova Sonic over the real SDK — the request', () => {
  it('POSTs an event stream to the model\'s bidirectional path', async () => {
    const { req } = await openOk();
    expect(req.headers[':method']).toBe('POST');
    expect(req.headers[':path']).toBe('/model/amazon.nova-2-sonic-v1%3A0/invoke-with-bidirectional-stream');
    expect(req.headers['content-type']).toBe('application/vnd.amazon.eventstream');
    expect(req.headers['x-amz-content-sha256']).toBe('STREAMING-AWS4-HMAC-SHA256-EVENTS');
  });

  it('signs with the ctx credentials and region, never process.env, and never sends the secret', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAENVMUSTNOTBEUSED');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret-must-not-be-used');
    vi.stubEnv('AWS_REGION', 'eu-west-3');
    const { req } = await openOk();
    const auth = String(req.headers.authorization);
    expect(auth).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${ID}/\\d{8}/ap-northeast-1/bedrock/aws4_request, `));
    expect(auth).not.toContain('AKIAENV');
    secretFree(JSON.stringify(req.headers));
    expect(req.headers['x-amz-security-token']).toBeUndefined();
  });

  it('forwards a session token from ctx as x-amz-security-token', async () => {
    const { req } = await openOk({ AWS_SESSION_TOKEN: TOKEN });
    expect(req.headers['x-amz-security-token']).toBe(TOKEN);
  });

  it.each([
    [{ AWS_REGION: undefined, AWS_DEFAULT_REGION: 'eu-central-1' }, 'eu-central-1'],
    [{ AWS_REGION: undefined }, 'us-east-1'],
  ])('region fallback %j -> %s', async (creds, region) => {
    const { req } = await openOk(creds);
    expect(String(req.headers.authorization)).toContain(`/${region}/bedrock/aws4_request`);
  });

  it('every input event is a signed envelope around one `chunk` event carrying the JSON', async () => {
    const { req } = await openOk();
    expect(req.events.map(nameOf)).toEqual(PREAMBLE);
    for (const names of req.envelopeHeaders) expect(names).toEqual(expect.arrayContaining([':date', ':chunk-signature']));
    for (const h of req.chunkHeaders) {
      expect(h[':event-type']).toBe('chunk');
      expect(h[':message-type']).toBe('event');
    }
    // Nova takes no language parameter; it must not appear on the real wire either.
    expect(JSON.stringify(req.events)).not.toMatch(/en-GB|"language/);
    expect(req.events[1].event.promptStart.audioOutputConfiguration.voiceId).toBe('amy');
    secretFree(JSON.stringify(req.events));
  });

  it('mic audio reaches Bedrock as audioInput at 16 kHz in the conversation\'s single audio block', async () => {
    const { session, req } = await openOk();
    const audioBlock = req.events[5].event.contentStart.contentName;
    session.pushAudio(ramp(2400)); // 100ms @ 24k
    await waitFor(() => req.events.some((e) => nameOf(e) === 'audioInput'), 'audioInput');
    const input = req.events.find((e) => nameOf(e) === 'audioInput')!.event.audioInput;
    expect(input.contentName).toBe(audioBlock);
    expect(Buffer.from(input.content, 'base64').length).toBe(1600 * 2);
  });
});

describe('Nova Sonic over the real SDK — responses', () => {
  it('decodes chunk members into events: audio is emitted and usage billed from the deltas', async () => {
    const { session, rec, req } = await openOk();
    session.commitAudio(); // manual: t0
    const audio = ramp(4800, 9); // 200ms @ 24k
    for (const ev of [
      { completionStart: { completionId: 'c1' } },
      { contentStart: { completionId: 'c1', contentId: 'u', type: 'TEXT', role: 'USER', additionalModelFields: '{"generationStage":"FINAL"}' } },
      { textOutput: { completionId: 'c1', contentId: 'u', content: 'hello nova' } },
      { contentStart: { completionId: 'c1', contentId: 'a', type: 'AUDIO', role: 'ASSISTANT' } },
      { audioOutput: { completionId: 'c1', contentId: 'a', content: audio.toString('base64') } },
      { contentEnd: { completionId: 'c1', contentId: 'a', stopReason: 'END_TURN' } },
      { usageEvent: { completionId: 'c1', details: { delta: { input: { speechTokens: 20, textTokens: 4 }, output: { speechTokens: 50, textTokens: 6 } } }, totalInputTokens: 99999 } },
      { completionEnd: { completionId: 'c1', stopReason: 'END_TURN' } },
    ]) {
      req.stream.write(bedrockChunk(ev));
    }
    await waitFor(() => rec.usage.length === 1, 'usage');
    expect(Buffer.concat(rec.audio).equals(audio)).toBe(true);
    expect(rec.user).toEqual([{ text: 'hello nova', final: true, turnId: 1 }]);
    expect(rec.usage[0].legs[0]).toMatchObject({
      source: 'vendor',
      inputUnits: 24,
      outputUnits: 56,
      audioInputTokens: 20,
      audioOutputTokens: 50,
      audioSeconds: 0.2,
    });
    expect(rec.errors).toEqual([]);
  });

  it('a 403 at the handshake rejects start() with the vendor\'s message, free of key material', async () => {
    fake.onRequest((r) => {
      r.stream.respond({
        ':status': 403,
        'content-type': 'application/json',
        'x-amzn-errortype': 'UnrecognizedClientException:http://internal.amazon.com/coral/com.amazon.coral.service/',
        'x-amzn-requestid': 'req-1',
      });
      r.stream.end(JSON.stringify({ message: 'The security token included in the request is invalid.' }));
    });
    const { session, rec } = create({ AWS_SESSION_TOKEN: TOKEN });
    const err = await session.start().then(
      () => undefined,
      (e: Error) => e,
    );
    expect(err?.message).toBe('The security token included in the request is invalid.');
    expect(err?.name).toBe('UnrecognizedClientException');
    secretFree(`${err?.message}\n${err?.stack}\n${JSON.stringify(err)}`);
    await flushIo();
    expect(rec.turnStarts).toEqual([]);
    secretFree(rec.everything());
  });

  it('a modeled exception mid-stream is surfaced with the vendor message and ends the session, billing the turn', async () => {
    const { session, rec, req } = await openOk();
    session.commitAudio();
    req.stream.write(bedrockChunk({ completionStart: { completionId: 'c1' } }));
    req.stream.write(bedrockChunk({ audioOutput: { completionId: 'c1', content: tone(40).toString('base64') } }));
    await waitFor(() => rec.audio.length === 1, 'audio');
    req.stream.write(bedrockException('throttlingException', 'Too many requests, please wait'));
    await waitFor(() => rec.usage.length === 1, 'turn billed after stream loss');

    expect(rec.errors.some((e) => e.message.includes('Too many requests, please wait'))).toBe(true);
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage[0].legs[0].unpricedReason).toBe('stream closed before the vendor reported usage');
    secretFree(rec.everything());

    // The session is closed: nothing more reaches the transport.
    const count = req.events.length;
    session.pushAudio(tone(40));
    session.sendText('still there?');
    await flushIo();
    expect(req.events.length).toBe(count);
  });

  it('the vendor ending the response stream is reported as an unexpected close', async () => {
    const { session, rec, req } = await openOk();
    session.commitAudio();
    req.stream.write(bedrockChunk({ completionStart: { completionId: 'c1' } }));
    req.stream.end();
    await waitFor(() => rec.errors.length >= 1, 'close reported');
    expect(rec.errors.map((e) => e.message)).toContain('Nova Sonic stream closed unexpectedly');
    expect(rec.turnEnds).toEqual([1]);
    expect(rec.usage).toHaveLength(1);
  });

  it('an unreadable chunk payload is skipped without taking the conversation down', async () => {
    const { session, rec, req } = await openOk();
    session.commitAudio();
    req.stream.write(bedrockChunk({ completionStart: { completionId: 'c1' } }));
    // A chunk whose bytes are not JSON.
    req.stream.write(
      encodeEventStream(
        { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
        Buffer.from(JSON.stringify({ bytes: Buffer.from('not json').toString('base64') })),
      ),
    );
    req.stream.write(bedrockChunk({ audioOutput: { completionId: 'c1', content: tone(20).toString('base64') } }));
    await waitFor(() => rec.audio.length === 1, 'audio after the bad chunk');
    expect(rec.errors).toEqual([]);
  });
});

describe('Nova Sonic over the real SDK — teardown', () => {
  /*
   * Was a bug: endInput() waited only on `whenDrained` (the EventQueue PULLED
   * dry), not for the SDK to sign and write what it pulled, so destroy() tore
   * the HTTP/2 session down and none of contentEnd / promptEnd / sessionEnd
   * reached the fake. endInput() now also waits for the request stream's
   * `finish` (bounded by TEARDOWN_DRAIN_MS), honouring the NovaTransport
   * contract that queued events "reach the wire". The WebSocket stand-in
   * cannot see this; neither fake is Bedrock.
   */
  it('close() gets contentEnd -> promptEnd -> sessionEnd onto the wire, then half-closes the request', async () => {
    const { session, req } = await openOk();
    session.pushAudio(silence(20));
    await session.close();
    await waitFor(() => req.ended, 'request stream ended');
    const tail = req.events.slice(-3);
    expect(tail.map(nameOf)).toEqual(['contentEnd', 'promptEnd', 'sessionEnd']);
    expect(tail[0].event.contentEnd.contentName).toBe(req.events[5].event.contentStart.contentName);
    await session.close(); // idempotent
  });
});
