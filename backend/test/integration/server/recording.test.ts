import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  bootServer,
  filesIn,
  frames,
  loudPcm,
  parseWav,
  pipelineConfig,
  rawRequest,
  silentPcm,
  uniquePrompt,
  until,
  WsClient,
  type ServerHandle,
} from './helpers.js';
import type { SessionSummary } from '../../../src/shared/protocol.js';

/**
 * `start_recording` has no acknowledgement, and the recorder opens its channel
 * files asynchronously — mic audio sent before they exist is not recorded. The
 * channel temp file appearing on disk is the only observable "armed" signal.
 */
async function armRecording(server: ServerHandle, ws: WsClient): Promise<void> {
  const before = new Set(filesIn(server.sessionDir).filter((f) => f.includes('.mic.')));
  ws.send({ type: 'start_recording' });
  await until(
    () => filesIn(server.sessionDir).some((f) => f.includes('.mic.') && f.endsWith('.tmp') && !before.has(f)),
    'the recorder to open its channels',
  );
}

/** One spoken pipeline turn: speech, then enough silence for the mock VAD. */
async function speakTurn(ws: WsClient, speech: Buffer, turnId: number): Promise<void> {
  for (const f of frames(Buffer.concat([speech, silentPcm(680)]))) ws.sendAudio(f);
  await ws.next('usage', (u) => u.turnId === turnId);
}

describe('conversation recording (SESSION_AUDIO on)', () => {
  let server: ServerHandle;
  let recordId: string;
  let wavPath: string;
  let size: number;
  let micSpeech: Buffer;
  let botAudio: Buffer;

  beforeAll(async () => {
    server = await bootServer();
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('recording')) });
    await ws.next('session_started');
    await armRecording(server, ws);
    micSpeech = loudPcm(600, 300);
    await speakTurn(ws, micSpeech, 1);
    botAudio = ws.audioBytes();
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    await ws.close();
    recordId = summary.recordId;
    wavPath = join(server.sessionDir, `${recordId}.wav`);
    size = statSync(wavPath).size;
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('writes one stereo PCM16 24 kHz WAV beside the JSON, with no temp files left', () => {
    const files = filesIn(server.sessionDir).filter((f) => f.startsWith(recordId));
    expect(files.sort()).toEqual([`${recordId}.json`, `${recordId}.wav`]);
    const wav = parseWav(readFileSync(wavPath));
    expect(wav.channels).toBe(2);
    expect(wav.sampleRate).toBe(24_000);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.dataBytes).toBe(size - 44);
    expect(wav.riffSize).toBe(size - 8);
  });

  it('left channel is the microphone and right channel is the assistant, byte for byte', () => {
    const wav = parseWav(readFileSync(wavPath));
    // Sent faster than real time, so each side was laid down contiguously.
    expect(wav.left.indexOf(micSpeech)).toBeGreaterThanOrEqual(0);
    expect(wav.right.indexOf(botAudio)).toBeGreaterThanOrEqual(0);
    // And neither side bled into the other.
    const micSlice = micSpeech.subarray(4800, 9600);
    const botSlice = botAudio.subarray(botAudio.length / 2, botAudio.length / 2 + 4800);
    expect(wav.right.indexOf(micSlice)).toBe(-1);
    expect(wav.left.indexOf(botSlice)).toBe(-1);
    // The assistant answered after the user spoke, so its audio starts later.
    const firstNonZero = (b: Buffer) => {
      for (let i = 0; i < b.length; i += 2) if (b.readInt16LE(i) !== 0) return i;
      return -1;
    };
    expect(firstNonZero(wav.right)).toBeGreaterThan(firstNonZero(wav.left));
  });

  describe('GET /api/sessions/:id/audio', () => {
    const url = () => `/api/sessions/${recordId}/audio`;

    it('serves the whole file with Accept-Ranges when no Range is asked for', async () => {
      const r = await rawRequest(server, url());
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('audio/wav');
      expect(r.headers['accept-ranges']).toBe('bytes');
      expect(r.headers['content-length']).toBe(String(size));
      expect(r.body.equals(readFileSync(wavPath))).toBe(true);
    });

    it('HEAD answers the headers with no body', async () => {
      const r = await rawRequest(server, url(), { method: 'HEAD' });
      expect(r.status).toBe(200);
      expect(r.headers['content-length']).toBe(String(size));
      expect(r.body.length).toBe(0);
    });

    const ok: Array<[string, (n: number) => [number, number]]> = [
      ['bytes=0-43', () => [0, 43]],
      ['bytes=0-0', () => [0, 0]],
      ['bytes=100-', (n) => [100, n - 1]],
      ['bytes=-100', (n) => [n - 100, n - 1]],
      ['bytes=10-20', () => [10, 20]],
    ];
    for (const [range, expected] of ok) {
      it(`${range} is a 206 with the right slice and Content-Range`, async () => {
        const [start, end] = expected(size);
        const r = await rawRequest(server, url(), { headers: { range } });
        expect(r.status).toBe(206);
        expect(r.headers['content-range']).toBe(`bytes ${start}-${end}/${size}`);
        expect(r.headers['content-length']).toBe(String(end - start + 1));
        expect(r.headers['content-type']).toBe('audio/wav');
        expect(r.body.equals(readFileSync(wavPath).subarray(start, end + 1))).toBe(true);
      });
    }

    it('the header range reads back a valid RIFF header', async () => {
      const r = await rawRequest(server, url(), { headers: { range: 'bytes=0-43' } });
      expect(r.body.toString('ascii', 0, 4)).toBe('RIFF');
      expect(r.body.toString('ascii', 8, 12)).toBe('WAVE');
    });

    it('an end past EOF is clamped to the last byte', async () => {
      const r = await rawRequest(server, url(), { headers: { range: `bytes=${size - 10}-${size * 10}` } });
      expect(r.status).toBe(206);
      expect(r.headers['content-range']).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
      expect(r.body.length).toBe(10);
    });

    it('a suffix longer than the file is the whole file', async () => {
      const r = await rawRequest(server, url(), { headers: { range: `bytes=-${size * 2}` } });
      expect(r.status).toBe(206);
      expect(r.headers['content-range']).toBe(`bytes 0-${size - 1}/${size}`);
      expect(r.body.length).toBe(size);
    });

    for (const range of ['bytes=-0', 'bytes=-', 'bytes=50-10']) {
      it(`${range} is a 416 naming the size`, async () => {
        const r = await rawRequest(server, url(), { headers: { range } });
        expect(r.status).toBe(416);
        expect(r.headers['content-range']).toBe(`bytes */${size}`);
        expect(r.body.length).toBe(0);
      });
    }

    it('a start at or past EOF is a 416', async () => {
      for (const start of [size, size + 1000]) {
        const r = await rawRequest(server, url(), { headers: { range: `bytes=${start}-` } });
        expect(r.status).toBe(416);
        expect(r.headers['content-range']).toBe(`bytes */${size}`);
      }
    });

    it('a Range it does not understand is ignored and the full file served', async () => {
      for (const range of ['bytes=0-1,5-6', 'items=0-10', 'garbage']) {
        const r = await rawRequest(server, url(), { headers: { range } });
        expect(r.status).toBe(200);
        expect(r.body.length).toBe(size);
      }
    });

    it('a client that aborts mid-body does not wedge the server', async () => {
      for (let i = 0; i < 20; i++) {
        const ctrl = new AbortController();
        const res = await fetch(`${server.base}${url()}`, { signal: ctrl.signal });
        ctrl.abort();
        await res.body?.cancel().catch(() => undefined);
      }
      const r = await rawRequest(server, url(), { headers: { range: 'bytes=0-3' } });
      expect(r.body.toString('ascii')).toBe('RIFF');
    });
  });

  it('toggling the mic mid-conversation does not split the recording', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('toggle')) });
    await ws.next('session_started');
    await armRecording(server, ws);
    const first = loudPcm(400, 310);
    await speakTurn(ws, first, 1);
    // Mic off and on again: the client sends start_recording a second time.
    ws.send({ type: 'start_recording' });
    ws.send({ type: 'start_recording' });
    const second = loudPcm(400, 520);
    await speakTurn(ws, second, 2);
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    await ws.close();

    const mine = filesIn(server.sessionDir).filter((f) => f.startsWith(summary.recordId));
    expect(mine.sort()).toEqual([`${summary.recordId}.json`, `${summary.recordId}.wav`]);
    expect(filesIn(server.sessionDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const wav = parseWav(readFileSync(join(server.sessionDir, `${summary.recordId}.wav`)));
    const a = wav.left.indexOf(first);
    const b = wav.left.indexOf(second);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a + first.length);
  });

  it('a barge-in truncates assistant audio that was generated but never heard', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('barge-in')) });
    await ws.next('session_started');
    await armRecording(server, ws);
    ws.send({ type: 'user_text', text: Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ') });
    // Mock TTS renders far faster than real time: by 1.5 s of audio, the
    // assistant channel is well ahead of the wall clock.
    await until(() => ws.audioBytes().length > 1.5 * 48_000, 'audio ahead of the clock');
    ws.send({ type: 'interrupt' });
    await ws.next('usage');
    const received = ws.audioBytes().length;
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    await ws.close();

    const wav = parseWav(readFileSync(join(server.sessionDir, `${summary.recordId}.wav`)));
    // What was cut off is gone from the file: the right channel is shorter
    // than what the server emitted.
    expect(wav.right.length).toBeLessThan(received);
    expect(wav.right.length).toBeGreaterThan(0);
  });

  it('a recording that never got a turn is discarded with its conversation', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('no-turn')) });
    await ws.next('session_started');
    await armRecording(server, ws);
    ws.sendAudio(silentPcm(100)); // below the tail threshold, so no record at all
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    expect(summary.turnCount).toBe(0);
    await ws.close();
    await until(() => !filesIn(server.sessionDir).some((f) => f.startsWith(summary.recordId)), 'cleanup');
    expect((await fetch(`${server.base}/api/sessions/${summary.recordId}/audio`)).status).toBe(404);
  });

  it('a conversation that never armed the recorder has a record but no WAV', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('never-armed')) });
    await ws.next('session_started');
    ws.send({ type: 'user_text', text: 'typed only' });
    await ws.next('usage');
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    await ws.close();
    expect(filesIn(server.sessionDir).filter((f) => f.startsWith(summary.recordId))).toEqual([`${summary.recordId}.json`]);
    const r = await fetch(`${server.base}/api/sessions/${summary.recordId}/audio`);
    expect(r.status).toBe(404);
  });
});

describe('SESSION_AUDIO=0', () => {
  let server: ServerHandle;
  beforeAll(async () => {
    server = await bootServer({ env: { SESSION_AUDIO: '0' } });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('records nothing — no WAV, no channel temps — but still files the JSON', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('audio-off')) });
    await ws.next('session_started');
    ws.send({ type: 'start_recording' });
    await speakTurn(ws, loudPcm(500), 1);
    // The recorder would have opened its channels long before the turn ended.
    expect(filesIn(server.sessionDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    ws.send({ type: 'end_conversation' });
    const { summary } = await ws.next('session_summary');
    await ws.close();
    expect(filesIn(server.sessionDir)).toEqual([`${summary.recordId}.json`]);
    expect((await fetch(`${server.base}/api/sessions/${summary.recordId}/audio`)).status).toBe(404);
    const rec = (await (await fetch(`${server.base}/api/sessions/${summary.recordId}`)).json()) as SessionSummary;
    expect(rec.turnCount).toBe(1);
  });
});

describe('SESSION_AUDIO_MAX_MINUTES', () => {
  let server: ServerHandle;
  // 0.01 min = 600 ms = 14 400 samples per channel.
  beforeAll(async () => {
    server = await bootServer({ env: { SESSION_AUDIO_MAX_MINUTES: '0.01' } });
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('closes the recording at the cap, keeps what it has, and warns the client', async () => {
    const ws = await WsClient.connect(server.wsUrl);
    ws.send({ type: 'start', config: pipelineConfig(uniquePrompt('cap')) });
    await ws.next('session_started');
    await armRecording(server, ws);
    await speakTurn(ws, loudPcm(900), 1);
    ws.send({ type: 'end_conversation' });
    const warn = await ws.seen('log', (l) => l.level === 'warn' && l.message.includes('cap'));
    expect(warn.message).toBe('Recording hit the 0.01-minute cap and was closed early.');
    const { summary } = await ws.next('session_summary');
    await ws.close();
    const wav = parseWav(readFileSync(join(server.sessionDir, `${summary.recordId}.wav`)));
    expect(wav.dataBytes).toBe(14_400 * 4);
    expect(wav.left.some((b) => b !== 0)).toBe(true);
  });
});
