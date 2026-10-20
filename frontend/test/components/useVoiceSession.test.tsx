// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { claimTtfa, useVoiceSession } from '../../src/hooks/useVoiceSession';
import { AUTH_STORAGE_KEY } from '../../src/lib/auth';
import type { ServerMessage, StartConfig } from '../../src/lib/protocol';
import { FakeAudioSink, FakeMicRecorder, FakeWebSocket, lastSocket, resetFakes } from './fakes';
import { NOW, SYNTHETIC, pipelineTurn } from './fixtures';

vi.mock('../../src/audio/player', async () => ({ AudioSink: (await import('./fakes')).FakeAudioSink }));
vi.mock('../../src/audio/recorder', async () => ({ MicRecorder: (await import('./fakes')).FakeMicRecorder }));

const config: StartConfig = {
  mode: 'pipeline',
  sttProviderId: 'sarvam-stt', sttModelId: 'saaras:v3-realtime@fast',
  llmProviderId: 'google-llm', llmModelId: 'gemini-3.1-flash-lite@minimal',
  ttsProviderId: 'murf-tts', ttsModelId: 'falcon-2',
  systemPrompt: 'Be brief.', voice: 'en-US-natalie', turnDetection: 'server_vad',
};

const started: ServerMessage = { type: 'session_started', sessionId: 's-1', mode: 'pipeline', sampleRate: 24000, label: 'sarvam → google → murf' };
const metricsFrame = (turnId = 1): ServerMessage => ({ type: 'metrics', turnId, marks: pipelineTurn.marks, derived: pipelineTurn.derived });

type Hook = ReturnType<typeof renderHook<ReturnType<typeof useVoiceSession>, unknown>>;

async function connected(cfg: StartConfig = config): Promise<{ hook: Hook; ws: FakeWebSocket; sink: FakeAudioSink }> {
  const hook = renderHook(() => useVoiceSession());
  await act(async () => {
    await hook.result.current.connect(cfg);
  });
  const ws = lastSocket();
  act(() => ws.serverOpen());
  act(() => ws.serverSend(started));
  return { hook, ws, sink: FakeAudioSink.instances[0] };
}

const push = (ws: FakeWebSocket, ...msgs: ServerMessage[]) => act(() => msgs.forEach((m) => ws.serverSend(m)));

describe('useVoiceSession', () => {
  beforeEach(() => {
    resetFakes();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('starts idle with nothing in it', () => {
    const { result } = renderHook(() => useVoiceSession());
    expect(result.current).toMatchObject({
      state: 'idle', label: '', sessionId: '', micOn: false, micLevel: 0, assistantSpeaking: false,
      utterances: [], turns: [], mode: undefined, usage: [], summary: null, logs: [],
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  describe('connect', () => {
    it('resumes audio, opens the session socket, and sends start with the config once open', async () => {
      const { result } = renderHook(() => useVoiceSession());
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.connect(config);
      });
      expect(result.current.state).toBe('connecting');
      expect(result.current.mode).toBe('pipeline');
      await act(async () => pending);
      const ws = lastSocket();
      expect(ws.url).toBe(`ws://${location.host}/ws/session`);
      expect(ws.binaryType).toBe('arraybuffer');
      expect(FakeAudioSink.instances[0].resumeCalls).toBe(1);
      expect(ws.sent).toEqual([]);
      act(() => ws.serverOpen());
      expect(ws.json).toEqual([{ type: 'start', config }]);
      expect(result.current.state).toBe('connecting');
    });

    it('carries the session token on the upgrade URL when signed in', async () => {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'a b', username: 'u', expiresAt: NOW * 10 }));
      const { result } = renderHook(() => useVoiceSession());
      await act(async () => result.current.connect(config));
      expect(lastSocket().url).toBe(`ws://${location.host}/ws/session?token=a%20b`);
    });

    it('session_started makes it ready, names it, and logs it', async () => {
      const { hook } = await connected();
      const s = hook.result.current;
      expect(s.state).toBe('ready');
      expect(s.sessionId).toBe('s-1');
      expect(s.label).toBe('sarvam → google → murf');
      // Its source is a guess (the label names three vendors), so it is not asserted.
      expect(s.logs.at(-1)).toMatchObject({ level: 'info', kind: 'log', message: 'session s-1 · pipeline · sarvam → google → murf' });
    });

    it('an audio output that will not resume is an error, with no socket and a log line', async () => {
      FakeAudioSink.resumeError = new Error('NotAllowedError');
      const { result } = renderHook(() => useVoiceSession());
      await act(async () => result.current.connect(config));
      expect(result.current.state).toBe('error');
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(result.current.logs).toEqual([
        expect.objectContaining({ level: 'error', message: 'audio output unavailable: NotAllowedError', source: 'client' }),
      ]);
    });

    it('reuses one audio sink across sessions', async () => {
      const { hook } = await connected();
      await act(async () => hook.result.current.connect(config));
      expect(FakeAudioSink.instances).toHaveLength(1);
      expect(FakeAudioSink.instances[0].resumeCalls).toBe(2);
    });

    it('a second connect replaces the first socket and wipes its state', async () => {
      const { hook, ws: first } = await connected();
      push(first, { type: 'transcript', role: 'user', text: 'hi', final: true, turnId: 1 }, metricsFrame());
      expect(hook.result.current.turns).toHaveLength(1);
      await act(async () => hook.result.current.connect({ ...config, mode: 'realtime' }));
      expect(first.closed).toBe(true);
      expect(first.onmessage).toBeNull();
      expect(first.onclose).toBeNull();
      const s = hook.result.current;
      expect(s).toMatchObject({ state: 'connecting', utterances: [], turns: [], usage: [], summary: null, logs: [], mode: 'realtime' });
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
  });

  describe('server frames', () => {
    it('binary frames go to the audio sink untouched', async () => {
      const { ws, sink } = await connected();
      const buf = new Int16Array([1, 2, 3]).buffer;
      act(() => ws.serverBinary(buf));
      expect(sink.enqueued).toEqual([buf]);
    });

    it('partials are replaced in place; a final settles the line; roles alternate', async () => {
      const { hook, ws, sink } = await connected();
      push(ws,
        { type: 'transcript', role: 'user', text: 'hel', final: false, turnId: 0 },
        { type: 'transcript', role: 'user', text: 'hello', final: false, turnId: 0 },
      );
      expect(hook.result.current.utterances).toEqual([{ role: 'user', text: 'hello', final: false }]);
      push(ws, { type: 'transcript', role: 'user', text: 'hello there', final: true, turnId: 1 });
      expect(hook.result.current.utterances).toEqual([{ role: 'user', text: 'hello there', final: true }]);
      // A final user line arms the sink for the reply's first audible sample.
      expect(sink.expectCalls).toBe(1);
      push(ws,
        { type: 'transcript', role: 'assistant', text: 'Hi', final: false, turnId: 1 },
        { type: 'transcript', role: 'assistant', text: 'Hi!', final: true, turnId: 1 },
        { type: 'transcript', role: 'user', text: 'again', final: true, turnId: 2 },
      );
      expect(hook.result.current.utterances).toEqual([
        { role: 'user', text: 'hello there', final: true },
        { role: 'assistant', text: 'Hi!', final: true },
        { role: 'user', text: 'again', final: true },
      ]);
      expect(sink.expectCalls).toBe(2);
    });

    it('turn_start / turn_end drive assistantSpeaking', async () => {
      const { hook, ws } = await connected();
      push(ws, { type: 'turn_start', turnId: 1 });
      expect(hook.result.current.assistantSpeaking).toBe(true);
      push(ws, { type: 'turn_end', turnId: 1 });
      expect(hook.result.current.assistantSpeaking).toBe(false);
    });

    it('metrics append a turn under the session label and fan the marks into the console, sorted', async () => {
      const { hook, ws } = await connected();
      const shuffled: ServerMessage = { type: 'metrics', turnId: 7, marks: [...pipelineTurn.marks].reverse(), derived: pipelineTurn.derived };
      push(ws, shuffled);
      const s = hook.result.current;
      expect(s.turns).toEqual([
        { turnId: 7, marks: [...pipelineTurn.marks].reverse(), derived: pipelineTurn.derived, clientTtfaMs: undefined, label: 'sarvam → google → murf' },
      ]);
      const marks = s.logs.filter((l) => l.kind === 'mark');
      expect(marks.map((m) => m.message)).toEqual(pipelineTurn.marks.map((m) => m.name));
      expect(marks[0]).toMatchObject({ turnId: 7, atMs: 0, source: 'session', detail: 't0 — every number in this turn is relative to this' });
      expect(marks.find((m) => m.message === 'tts_request_sent')).toMatchObject({ source: 'tts', atMs: 364 });
      expect(marks.find((m) => m.message === 'llm_first_token')?.source).toBe('llm');
      expect(marks.find((m) => m.message === 'stt_final')?.source).toBe('stt');
      push(ws, metricsFrame(8));
      expect(hook.result.current.turns.map((t) => t.turnId)).toEqual([7, 8]);
    });

    /*
     * BUG: the browser-side TTFA never reaches a turn. In the `metrics` case
     * (src/hooks/useVoiceSession.ts:288) `claimTtfa(lastClientTtfa.current, …)`
     * is evaluated INSIDE the `setTurns` updater, and line 292 nulls
     * `lastClientTtfa.current` synchronously right after. The `push(...)` of
     * the marks a few lines up has already queued a `setLogs` update on the
     * same fiber, so React cannot compute the `setTurns` updater eagerly; it
     * runs at render time, reads the nulled ref, and stores `undefined`.
     * Verified by running this same test against a copy of the hook that
     * reads the claim before calling `setTurns`: it passes there.
     */
    it.fails('the browser-side TTFA lands on the turn whose audio became audible', async () => {
      const now = vi.spyOn(performance, 'now');
      const { hook, ws, sink } = await connected();
      now.mockReturnValue(1000);
      push(ws, { type: 'transcript', role: 'user', text: 'q', final: true, turnId: 1 });
      now.mockReturnValue(1612.4);
      act(() => sink.becomeAudible());
      push(ws, metricsFrame(1));
      expect(hook.result.current.turns[0].clientTtfaMs).toBe(612);
      // One measurement, one turn: the next turn starts with nothing.
      push(ws, metricsFrame(2));
      expect(hook.result.current.turns[1].clientTtfaMs).toBeUndefined();
    });

    it('a measurement from an interrupted turn is not donated to the next', async () => {
      const now = vi.spyOn(performance, 'now');
      const { hook, ws, sink } = await connected();
      now.mockReturnValue(0);
      push(ws, { type: 'transcript', role: 'user', text: 'q', final: true, turnId: 1 });
      now.mockReturnValue(500);
      act(() => sink.becomeAudible());
      // Barge-in before the metrics frame: the sink moves on to a new token.
      act(() => hook.result.current.interrupt());
      push(ws, metricsFrame(1));
      expect(hook.result.current.turns[0].clientTtfaMs).toBeUndefined();
    });

    it('an audible report with no pending turn stashes nothing', async () => {
      const { hook, ws, sink } = await connected();
      act(() => sink.becomeAudible());
      push(ws, metricsFrame(1));
      expect(hook.result.current.turns[0].clientTtfaMs).toBeUndefined();
    });

    it('usage and the summary are kept', async () => {
      const { hook, ws } = await connected();
      push(ws, { type: 'usage', turnId: 1, usage: SYNTHETIC.turns[0] }, { type: 'usage', turnId: 2, usage: SYNTHETIC.turns[1] });
      expect(hook.result.current.usage).toEqual(SYNTHETIC.turns);
      push(ws, { type: 'session_summary', summary: SYNTHETIC });
      expect(hook.result.current.summary).toEqual(SYNTHETIC);
    });

    it('log frames keep their level and get a guessed source from the config', async () => {
      const { hook, ws } = await connected();
      push(ws,
        { type: 'log', level: 'warn', message: 'murf first frame ttfb 188ms' },
        { type: 'log', level: 'info', message: 'dynamic range adjusted' },
      );
      expect(hook.result.current.logs.slice(-2)).toEqual([
        expect.objectContaining({ level: 'warn', source: 'tts', kind: 'log' }),
        expect.objectContaining({ level: 'info', source: 'session' }),
      ]);
    });

    it('an error frame is logged and puts the session in error, socket left up', async () => {
      const { hook, ws } = await connected();
      push(ws, { type: 'error', message: 'Missing CARTESIA_API_KEY' });
      expect(hook.result.current.state).toBe('error');
      expect(hook.result.current.logs.at(-1)).toMatchObject({ level: 'error', message: 'Missing CARTESIA_API_KEY' });
      expect(ws.closed).toBe(false);
    });

    it.each([
      ['ended', 'ended'],
      ['stopped', 'closed'],
      [undefined, 'closed'],
    ] as const)('session_closed (%s) ends as %s and closes the socket', async (reason, state) => {
      const { hook, ws } = await connected();
      push(ws, { type: 'session_closed', reason });
      expect(hook.result.current.state).toBe(state);
      expect(ws.closed).toBe(true);
      expect(ws.onclose).toBeNull();
      // Nothing more is heard from it.
      expect(ws.onmessage).toBeNull();
    });

    it('a malformed log message does not take the session down', async () => {
      const { hook, ws } = await connected();
      act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'log', level: 'info', message: 42 }) } as MessageEvent));
      expect(hook.result.current.logs.at(-1)).toMatchObject({ message: 42, source: 'session' });
      expect(hook.result.current.state).toBe('ready');
    });

    it('caps the console buffer at the newest 600 lines', async () => {
      const { hook, ws } = await connected();
      act(() => {
        for (let i = 0; i < 650; i++) ws.serverSend({ type: 'log', level: 'info', message: `line ${i}` });
      });
      const logs = hook.result.current.logs;
      expect(logs).toHaveLength(600);
      expect(logs.at(-1)?.message).toBe('line 649');
      expect(logs[0].message).toBe('line 50');
    });
  });

  describe('socket failure', () => {
    it('an error event logs, sets error, and stops a hot mic', async () => {
      const { hook, ws } = await connected();
      await act(async () => hook.result.current.startMic());
      const rec = FakeMicRecorder.instances[0];
      await act(async () => ws.serverError());
      expect(hook.result.current.state).toBe('error');
      expect(hook.result.current.logs.at(-1)).toMatchObject({ level: 'error', message: 'WebSocket error — is the backend running on :8787?', source: 'client' });
      expect(rec.stopCalls).toBe(1);
      expect(hook.result.current.micOn).toBe(false);
      // The close that follows an error leaves the error showing.
      await act(async () => ws.serverClose(1006));
      expect(hook.result.current.state).toBe('error');
    });

    it('an unexpected close reads as closed and stops the mic', async () => {
      const { hook, ws } = await connected();
      await act(async () => hook.result.current.startMic());
      await act(async () => ws.serverClose(1006));
      expect(hook.result.current.state).toBe('closed');
      expect(hook.result.current.micOn).toBe(false);
    });

    it('a 4401 close kicks the user to sign in again', async () => {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 't', username: 'u', expiresAt: NOW * 10 }));
      const expired = vi.fn();
      window.addEventListener('auth:expired', expired);
      try {
        const { hook, ws } = await connected();
        await act(async () => ws.serverClose(4401));
        expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
        expect(expired).toHaveBeenCalledTimes(1);
        expect(hook.result.current.logs.at(-1)).toMatchObject({ level: 'error', message: 'session expired — sign in again' });
        expect(hook.result.current.state).toBe('closed');
      } finally {
        window.removeEventListener('auth:expired', expired);
      }
    });
  });

  describe('mic', () => {
    it('arms recording before the mic opens, streams frames, and reports its level', async () => {
      const { hook, ws } = await connected();
      await act(async () => hook.result.current.startMic());
      const rec = FakeMicRecorder.instances[0];
      expect(ws.json.map((m) => m.type)).toEqual(['start', 'start_recording']);
      expect(hook.result.current.micOn).toBe(true);
      expect(hook.result.current.logs.at(-1)).toMatchObject({ message: 'mic open @ 24000Hz', source: 'mic' });
      const pcm = new ArrayBuffer(8);
      act(() => rec.cb!.onFrame(pcm));
      expect(ws.sent.at(-1)).toBe(pcm);
      act(() => rec.cb!.onLevel!(0.42));
      expect(hook.result.current.micLevel).toBe(0.42);
    });

    it('a second startMic while open does not open a second recorder', async () => {
      const { hook } = await connected();
      await act(async () => hook.result.current.startMic());
      await act(async () => hook.result.current.startMic());
      expect(FakeMicRecorder.instances).toHaveLength(1);
    });

    it('opened before the session is up, it warns that the turn is not recorded and drops frames', async () => {
      const { result } = renderHook(() => useVoiceSession());
      await act(async () => result.current.startMic());
      expect(result.current.logs[0]).toMatchObject({ level: 'warn', message: 'mic opened before the session was up — this turn is not being recorded' });
      expect(() => act(() => FakeMicRecorder.instances[0].cb!.onFrame(new ArrayBuffer(2)))).not.toThrow();
    });

    it('re-arms recording when a session starts with the mic already hot', async () => {
      const { hook, ws } = await connected();
      await act(async () => hook.result.current.startMic());
      // A server error leaves the mic up; Connect again starts a fresh session.
      push(ws, { type: 'error', message: 'boom' });
      await act(async () => hook.result.current.connect(config));
      const next = lastSocket();
      act(() => next.serverOpen());
      act(() => next.serverSend(started));
      expect(next.json.map((m) => m.type)).toEqual(['start', 'start_recording']);
    });

    it('a denied mic is logged, leaves it off, and can be retried', async () => {
      FakeMicRecorder.startError = new Error('Permission denied');
      const { hook } = await connected();
      await act(async () => hook.result.current.startMic());
      expect(hook.result.current.micOn).toBe(false);
      expect(hook.result.current.logs.at(-1)).toMatchObject({ level: 'error', message: 'mic denied: Permission denied', source: 'mic' });
      FakeMicRecorder.startError = null;
      await act(async () => hook.result.current.startMic());
      expect(FakeMicRecorder.instances).toHaveLength(2);
      expect(hook.result.current.micOn).toBe(true);
    });

    it('stopMic stops the recorder and zeroes the level, and sends no stop-recording frame', async () => {
      const { hook, ws } = await connected();
      await act(async () => hook.result.current.startMic());
      act(() => FakeMicRecorder.instances[0].cb!.onLevel!(0.9));
      await act(async () => hook.result.current.stopMic());
      expect(FakeMicRecorder.instances[0].stopCalls).toBe(1);
      expect(hook.result.current.micOn).toBe(false);
      expect(hook.result.current.micLevel).toBe(0);
      expect(ws.json.map((m) => m.type)).toEqual(['start', 'start_recording']);
      // A fresh recorder next time.
      await act(async () => hook.result.current.startMic());
      expect(FakeMicRecorder.instances).toHaveLength(2);
    });
  });

  describe('client actions', () => {
    it('sendText sends the turn and arms the sink', async () => {
      const { hook, ws, sink } = await connected();
      act(() => hook.result.current.sendText('what is the weather'));
      expect(ws.json.at(-1)).toEqual({ type: 'user_text', text: 'what is the weather' });
      expect(sink.expectCalls).toBe(1);
    });

    it('commitAudio ends a push-to-talk turn', async () => {
      const { hook, ws, sink } = await connected();
      act(() => hook.result.current.commitAudio());
      expect(ws.json.at(-1)).toEqual({ type: 'commit_audio' });
      expect(sink.expectCalls).toBe(1);
    });

    it('interrupt flushes playback, stops the speaking flag and tells the server', async () => {
      const { hook, ws, sink } = await connected();
      push(ws, { type: 'turn_start', turnId: 1 });
      act(() => hook.result.current.interrupt());
      expect(sink.flushCalls).toBe(1);
      expect(hook.result.current.assistantSpeaking).toBe(false);
      expect(ws.json.at(-1)).toEqual({ type: 'interrupt' });
    });

    it('actions are dropped, not thrown, without an open socket', () => {
      const { result } = renderHook(() => useVoiceSession());
      expect(() =>
        act(() => {
          result.current.sendText('x');
          result.current.commitAudio();
          result.current.interrupt();
        }),
      ).not.toThrow();
    });

    it('also drops actions on a socket that is still connecting', async () => {
      const { result } = renderHook(() => useVoiceSession());
      await act(async () => result.current.connect(config));
      act(() => result.current.sendText('too early'));
      expect(lastSocket().sent).toEqual([]);
    });
  });

  describe('ending', () => {
    it('endConversation asks for the bill, keeps the socket, and waits for the summary', async () => {
      const { hook, ws, sink } = await connected();
      await act(async () => hook.result.current.startMic());
      await act(async () => hook.result.current.endConversation());
      expect(hook.result.current.state).toBe('ending');
      expect(ws.json.at(-1)).toEqual({ type: 'end_conversation' });
      expect(FakeMicRecorder.instances[0].stopCalls).toBe(1);
      expect(sink.flushCalls).toBe(1);
      expect(ws.closed).toBe(false);
      push(ws, { type: 'session_summary', summary: SYNTHETIC }, { type: 'session_closed', reason: 'ended' });
      expect(hook.result.current.summary).toEqual(SYNTHETIC);
      expect(hook.result.current.state).toBe('ended');
    });

    it('gives up waiting after 8 s and says the conversation is still saved', async () => {
      vi.useFakeTimers();
      const { hook } = await connected();
      await act(async () => hook.result.current.endConversation());
      await act(async () => {
        vi.advanceTimersByTime(7999);
      });
      expect(hook.result.current.state).toBe('ending');
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(hook.result.current.state).toBe('closed');
      expect(hook.result.current.logs.at(-1)).toMatchObject({
        level: 'warn', message: 'No summary came back — the conversation is still saved server-side.',
      });
    });

    it('the timeout leaves a session that ended properly alone', async () => {
      vi.useFakeTimers();
      const { hook, ws } = await connected();
      await act(async () => hook.result.current.endConversation());
      push(ws, { type: 'session_summary', summary: SYNTHETIC }, { type: 'session_closed', reason: 'ended' });
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(hook.result.current.state).toBe('ended');
      expect(hook.result.current.logs.some((l) => l.message.startsWith('No summary came back'))).toBe(false);
    });

    /*
     * BUG (minor): the 8 s give-up timer from `endConversation`
     * (src/hooks/useVoiceSession.ts:419) is never cleared and is not tied to
     * the socket it was armed for. It only checks `prev === 'ending'`, so a
     * timer left over from conversation A closes conversation B if B is being
     * ended when A's timer fires — B is given less than its 8 s.
     */
    it.fails('a previous conversation\'s give-up timer does not cut the next one short', async () => {
      vi.useFakeTimers();
      const { hook, ws } = await connected();
      await act(async () => hook.result.current.endConversation());
      push(ws, { type: 'session_summary', summary: SYNTHETIC }, { type: 'session_closed', reason: 'ended' });
      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      await act(async () => hook.result.current.connect(config));
      const next = lastSocket();
      act(() => next.serverOpen());
      act(() => next.serverSend(started));
      await act(async () => hook.result.current.endConversation());
      // A's timer fires at 8 s; B was ended at ~2 s and is owed until ~10 s.
      await act(async () => {
        vi.advanceTimersByTime(6_500);
      });
      expect(hook.result.current.state).toBe('ending');
    });

    it('ending a session that is not ready does not invent an ending state', async () => {
      const { result } = renderHook(() => useVoiceSession());
      await act(async () => result.current.endConversation());
      expect(result.current.state).toBe('idle');
    });

    it('disconnect drops the session hard: stop sent, socket detached, state idle', async () => {
      const { hook, ws, sink } = await connected();
      await act(async () => hook.result.current.startMic());
      await act(async () => hook.result.current.disconnect());
      expect(ws.json.at(-1)).toEqual({ type: 'stop' });
      expect(ws.closed).toBe(true);
      expect(ws.onmessage).toBeNull();
      expect(FakeMicRecorder.instances[0].stopCalls).toBe(1);
      expect(sink.flushCalls).toBe(1);
      expect(hook.result.current.state).toBe('idle');
      expect(hook.result.current.label).toBe('');
      // Turns and the transcript stay readable after a hard drop.
      expect(hook.result.current.sessionId).toBe('s-1');
    });

    it('unmounting closes the socket, the mic and the audio output', async () => {
      const { hook, ws, sink } = await connected();
      await act(async () => hook.result.current.startMic());
      hook.unmount();
      expect(ws.closed).toBe(true);
      expect(FakeMicRecorder.instances[0].stopCalls).toBe(1);
      expect(sink.closeCalls).toBe(1);
    });
  });
});

describe('claimTtfa', () => {
  it('hands the stash only to the turn it was measured for', () => {
    expect(claimTtfa({ token: 3, ms: 410 }, 3)).toBe(410);
    expect(claimTtfa({ token: 3, ms: 410 }, 4)).toBeUndefined();
    expect(claimTtfa(null, 0)).toBeUndefined();
  });
});
