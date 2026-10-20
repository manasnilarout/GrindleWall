import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootServer,
  findRecordByPrompt,
  pipelineConfig,
  realtimeConfig,
  uniquePrompt,
  WsClient,
  type ServerHandle,
} from './helpers.js';
import { findProvider } from '../../../src/providers/catalog.js';
import type { StartConfig } from '../../../src/shared/protocol.js';

/** A valid start right after `bad` proves the socket and the process both survived it. */
async function expectStillServing(server: ServerHandle, ws: WsClient): Promise<void> {
  ws.send({ type: 'start', config: realtimeConfig('still alive?') });
  await ws.next('session_started', () => true, 5_000);
  const r = await fetch(`${server.base}/api/health`);
  expect(r.status).toBe(200);
}

describe('control-message and start errors', () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await bootServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('a text frame that is not JSON is answered with an error and the socket stays up', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send('{ this is not json');
    expect((await ws.next('error')).message).toBe('Malformed control message');
    ws.send('');
    expect((await ws.next('error')).message).toBe('Malformed control message');
    await expectStillServing(server, ws);
    await ws.close();
  });

  it('JSON that is not a known message is ignored silently', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    for (const frame of ['{"type":"bogus"}', '{}', '123', '"start"', '[]', 'true', '{"type":["start"]}']) ws.send(frame);
    await expectStillServing(server, ws);
    expect(ws.all('error')).toEqual([]);
    await ws.close();
  });

  const startErrors: Array<[string, Partial<StartConfig> & { mode: StartConfig['mode'] }, string]> = [
    ['an unknown STT provider', { ...pipelineConfig('x'), sttProviderId: 'nope-stt' }, 'Unknown stt provider: nope-stt'],
    ['an unknown LLM provider', { ...pipelineConfig('x'), llmProviderId: 'nope-llm' }, 'Unknown llm provider: nope-llm'],
    ['an unknown TTS provider', { ...pipelineConfig('x'), ttsProviderId: 'nope-tts' }, 'Unknown tts provider: nope-tts'],
    ['an unknown realtime provider', { ...realtimeConfig('x'), realtimeProviderId: 'nope-rt' }, 'Unknown realtime provider: nope-rt'],
    ['no realtime provider', { ...realtimeConfig('x'), realtimeProviderId: undefined }, 'No realtime provider selected'],
    ['no STT provider', { ...pipelineConfig('x'), sttProviderId: undefined }, 'No stt provider selected'],
    ['an unknown STT model', { ...pipelineConfig('x'), sttModelId: 'nope' }, 'Mock (canned) has no model "nope"'],
    ['an unknown LLM model', { ...pipelineConfig('x'), llmModelId: 'mock-chat@high' }, 'Mock (echo) has no model "mock-chat@high"'],
    ['an unknown TTS model', { ...pipelineConfig('x'), ttsModelId: 'nope' }, 'Mock (tone) has no model "nope"'],
    ['an unknown realtime model', { ...realtimeConfig('x'), realtimeModelId: 'nope' }, 'Mock (echo) has no model "nope"'],
    [
      'a catalog entry that is not wired up',
      { ...pipelineConfig('x'), sttProviderId: 'deepgram-stt', sttModelId: undefined },
      'Deepgram (deepgram-stt) is in the catalog but not wired up yet — register it in providers/factory.ts',
    ],
    [
      'a real provider whose key is missing',
      { ...pipelineConfig('x'), llmProviderId: 'openai-llm', llmModelId: findProvider('openai-llm')!.models[0].id },
      'OpenAI needs OPENAI_API_KEY in the environment',
    ],
    [
      'a realtime provider whose key is missing',
      { ...realtimeConfig('x'), realtimeProviderId: 'openai-realtime', realtimeModelId: undefined },
      'OpenAI Realtime needs OPENAI_API_KEY in the environment',
    ],
    [
      'AWS without credentials or a region',
      { ...realtimeConfig('x'), realtimeProviderId: 'aws-nova-sonic', realtimeModelId: undefined },
      'AWS Nova Sonic needs AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION in the environment',
    ],
  ];
  for (const [what, config, message] of startErrors) {
    it(`start with ${what} is refused with "${message.slice(0, 50)}"`, async () => {
      const ws = await WsClient.connect(server.wsUrl);
      ws.send({ type: 'start', config: config as StartConfig });
      expect((await ws.next('error')).message).toBe(message);
      expect(ws.all('session_started')).toEqual([]);
      // A failed start leaves nothing half-built: ending now is just a closure.
      ws.send({ type: 'end_conversation' });
      expect((await ws.next('session_closed')).reason).toBe('ended');
      expect(ws.all('session_summary')).toEqual([]);
      await expectStillServing(server, ws);
      await ws.close();
    });
  }

  it('a provider given in the wrong slot is refused, not run', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: { ...realtimeConfig('x'), realtimeProviderId: 'mock-stt' } });
    const { message } = await ws.next('error');
    // The message calls it "not wired up", which is misleading — it is wired, as STT.
    expect(message).toContain('(mock-stt)');
    await ws.close();
  });

  it('a start with no config at all is reported, not thrown', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send('{"type":"start"}');
    expect((await ws.next('error')).message).toMatch(/^Failed to start session: /);
    ws.send('{"type":"start","config":null}');
    expect((await ws.next('error')).message).toMatch(/^Failed to start session: /);
    // A pipeline config missing its system prompt fails in the session constructor.
    ws.send(JSON.stringify({ type: 'start', config: { ...pipelineConfig('x'), systemPrompt: undefined } }));
    expect((await ws.next('error')).message).toMatch(/^Failed to start session: /);
    await expectStillServing(server, ws);
    await ws.close();
  });

  it('omitted model ids fall back to each provider\'s first model', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({
      type: 'start',
      config: { ...pipelineConfig('x'), sttModelId: undefined, llmModelId: undefined, ttsModelId: undefined },
    });
    expect((await ws.next('session_started')).label).toBe(
      'mock-stt:mock-asr → mock-llm:mock-chat → mock-tts:mock-voice',
    );
    await ws.close();
  });

  it('odd-length and empty binary frames do not upset a live session', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig('x') });
    await ws.next('session_started');
    ws.sendAudio(Buffer.alloc(0));
    ws.sendAudio(Buffer.alloc(3));
    ws.sendAudio(Buffer.alloc(1921)); // odd length, silent (loud audio would barge in on the turn)
    ws.send({ type: 'user_text', text: 'still fine' });
    expect((await ws.next('transcript', (t) => t.role === 'assistant' && t.final)).text).toContain('still fine');
    await ws.close();
  });

  it('a client that disconnects with a session open does not affect other sockets', async () => {
    const a = await WsClient.connect(server.wsUrl);
    const b = await WsClient.connect(server.wsUrl);
    a.send({ type: 'start', config: pipelineConfig('a') });
    b.send({ type: 'start', config: pipelineConfig('b') });
    await a.next('session_started');
    await b.next('session_started');
    a.send({ type: 'user_text', text: 'gone soon' });
    await a.audioFrames(1);
    await a.terminate();
    b.send({ type: 'user_text', text: 'still here' });
    expect((await b.next('usage')).turnId).toBe(1);
    await b.close();
  });
});

/*
 * ---------------------------------------------------------------------------
 * Known bugs. Each is `it.fails`: the assertion states the CORRECT behaviour,
 * and the test passes for as long as the server gets it wrong. Each crash case
 * boots its own server, because the bug takes the whole process down.
 * ---------------------------------------------------------------------------
 */
describe('known bugs: a single control frame crashes the whole server', () => {
  async function withServer(fn: (server: ServerHandle) => Promise<void>, env: Record<string, string> = {}, sessionDir?: string) {
    const server = await bootServer({ env, sessionDir });
    try {
      await fn(server);
    } finally {
      await server.stop();
    }
  }

  // session-socket.ts:187 — `JSON.parse('null')` succeeds, then `msg.type`
  // throws inside the async 'message' handler; the rejection is unhandled and
  // Node exits. Any client can send it, before or after `start`.
  it.fails('the JSON literal null is ignored like any other non-message', async () => {
    await withServer(async (server) => {
      const ws = await WsClient.connect(server.wsUrl);
      ws.send('null');
      await expectStillServing(server, ws);
      await ws.close();
    });
  });

  // MockRealtimeProvider.ts:64 / PipelineSession.ts:165 — `text.trim()` on an
  // absent or non-string `text`, reached from session-socket.ts:233 without a
  // guard. Same unhandled rejection, same exit.
  it.fails('user_text without a string text is ignored', async () => {
    await withServer(async (server) => {
      const ws = await WsClient.connect(server.wsUrl);
      ws.send({ type: 'start', config: pipelineConfig('x') });
      await ws.next('session_started');
      ws.send('{"type":"user_text"}');
      ws.send('{"type":"user_text","text":5}');
      await expectStillServing(server, ws);
      await ws.close();
    });
  });

  // session-socket.ts:236-238 — `await recorder.start()` is unguarded, and
  // SessionRecorder.start() rethrows a failed mkdir/open. With SESSION_DIR
  // unusable (here: a regular file) the first `start_recording` exits Node
  // instead of costing only the recording.
  it.fails('a recorder that cannot open its files costs the recording, not the process', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gw-int-badir-'));
    const notADir = join(parent, 'not-a-dir');
    writeFileSync(notADir, 'x');
    await withServer(
      async (server) => {
        const ws = await WsClient.connect(server.wsUrl);
        ws.send({ type: 'start', config: realtimeConfig('x') });
        await ws.next('session_started');
        ws.send({ type: 'start_recording' });
        // Correct behaviour would be a warn log and a conversation that carries on.
        await ws.seen('log', (l) => l.level === 'warn', 5_000);
        await expectStillServing(server, ws);
        await ws.close();
      },
      {},
      notADir,
    );
  });
});

describe('known bugs: a pipeline turn cut off by the end of its conversation is never billed', () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await bootServer();
  });
  afterAll(async () => {
    await server?.stop();
  });

  /** ~300 words, so the mock LLM is still streaming for seconds after the first audio frame. */
  const LONG = Array.from({ length: 300 }, (_, i) => `token${i}`).join(' ');

  it('baseline: realtime bills a turn cut off by end_conversation', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: realtimeConfig(uniquePrompt('rt-cut')) });
    await ws.next('session_started');
    ws.send({ type: 'user_text', text: LONG });
    await ws.audioFrames(1);
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    expect(summary.turnCount).toBe(1);
    await ws.close();
  });

  // PipelineSession.interrupt() (called by close()) aborts the LLM and then
  // calls requestDrain(); with the LLM unsettled that defers emitUsage by
  // LLM_SETTLE_GRACE_MS (750 ms, PipelineSession.ts:32). session-socket.ts
  // finalize() builds and files the summary immediately after `await
  // session.close()`, so the turn — which ran and produced audio — is missing
  // from the summary and the record; 750 ms later onUsage finds no ledger and
  // only logs "arrived after the conversation was closed out".
  it.fails('end_conversation mid-answer bills the turn that was playing', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('pipe-cut')) });
    await ws.next('session_started');
    ws.send({ type: 'user_text', text: LONG });
    await ws.audioFrames(1);
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    expect(summary.turnCount).toBe(1);
    await ws.close();
  });

  // Same root cause on the socket-close path: finish() persists before the
  // drain timer fires, the ledger has 0 turns, so nothing is filed at all.
  it.fails('a tab closed mid-answer still files the turn that was playing', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    const prompt = uniquePrompt('pipe-vanish');
    ws.send({ type: 'start', config: pipelineConfig(prompt) });
    await ws.next('session_started');
    ws.send({ type: 'user_text', text: LONG });
    await ws.audioFrames(1);
    await ws.terminate();
    const row = await findRecordByPrompt(server, prompt, {}, () => true, 3_000);
    expect(row.turnCount).toBe(1);
  });

  // Worse on the replace path: `events` closes over the socket's `ledger`
  // variable, so when the old session's deferred usage fires it is billed into
  // the NEW conversation — here a realtime one, which acquires a pipeline turn
  // with stt/llm/tts legs that it never ran.
  it.fails('replacing a session mid-answer does not bill its turn to the next conversation', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('pipe-replaced')) });
    await ws.next('session_started');
    ws.send({ type: 'user_text', text: LONG });
    await ws.audioFrames(1);
    ws.send({ type: 'start', config: realtimeConfig(uniquePrompt('rt-replacer')) });
    await ws.next('session_started', (s) => s.mode === 'realtime');
    ws.send({ type: 'user_text', text: 'short' });
    await ws.next('transcript', (t) => t.role === 'assistant' && t.final);
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary', (s) => s.summary.mode === 'realtime');
    expect(summary.turns.flatMap((t) => t.legs.map((l) => l.leg))).toEqual(['realtime']);
    await ws.close();
  });
});
