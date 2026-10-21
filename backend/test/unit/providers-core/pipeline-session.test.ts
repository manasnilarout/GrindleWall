/**
 * PipelineSession, driven through hand-scripted fake STT/LLM/TTS legs so every
 * turn boundary can be placed exactly, under a fake clock (setTimeout AND
 * process.hrtime, so latency marks are exact milliseconds).
 *
 * The invariants pinned here are CLAUDE.md's:
 *   - t0 for every latency number is user_speech_end, set by beginTurn()
 *   - a turn is pending (t0 marked, transcript unknown) or running; a pending
 *     turn that never runs is abandoned and hands its banked STT audio back
 *   - barge-in cancels TTS and aborts the LLM synchronously, and raises
 *     onInterrupt when audio was already on the wire
 *   - usage is counted in the unit the vendor bills; a missing vendor count is
 *     estimated and flagged 'local'
 *   - audio left over after the last turn is a tail record with only an STT leg
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineSession } from '../../../src/pipeline/PipelineSession.js';
import { createSession } from '../../../src/providers/factory.js';
import type { LegUsage, StartConfig } from '../../../src/shared/protocol.js';
import { silence, tone } from '../../../src/audio/pcm.js';
import {
  BYTES_PER_SECOND,
  Recorder,
  SR,
  leg,
  loud,
  markAt,
  markNames,
  pipeline,
  quiet,
  spokenTurn,
  sttSeconds,
  textTurn,
  tick,
  useFakeClock,
} from './helpers.js';

const GRACE = 750; // LLM_SETTLE_GRACE_MS
const chunk = (ms: number) => Buffer.alloc((ms * SR * 2) / 1000, 1);

beforeEach(() => useFakeClock());
afterEach(() => vi.useRealTimers());

/* =============================== construction =============================== */

describe('construction and start()', () => {
  it('labels the three legs with their resolved models', () => {
    const h = pipeline({ models: { stt: 's:1', llm: 'l@v', tts: 't-2' } });
    expect(h.session.label).toBe('fake-stt:s:1 → fake-llm:l@v → fake-tts:t-2');
    expect(h.session.mode).toBe('pipeline');
    expect(h.session.id).toBe('sess-1');
  });

  it('opens the STT leg once with the canonical rate, the model, credentials and server VAD', async () => {
    const h = pipeline({ config: { language: 'en-IN' } });
    await h.session.start();
    expect(h.stt.opens).toBe(1);
    expect(h.stt.opts).toEqual({ model: 'stt-m', language: 'en-IN', sampleRate: 24000, credentials: h.credentials, vad: true });
    expect(h.stt.opts!.credentials).toBe(h.credentials);
    expect(h.rec.of('log')).toEqual([{ type: 'log', level: 'info', message: `pipeline ready: ${h.session.label}` }]);
  });

  it('manual turn detection asks the STT leg for no VAD', async () => {
    const h = pipeline({ config: { turnDetection: 'manual' } });
    await h.session.start();
    expect(h.stt.opts!.vad).toBe(false);
  });

  it.each([
    [{ language: 'en-IN' }, 'en-IN', 'en-IN'],
    [{ language: 'en-IN', sttLanguage: 'auto' }, 'auto', 'en-IN'],
    [{ language: 'en-IN', ttsLanguage: 'hi-IN' }, 'en-IN', 'hi-IN'],
    [{ sttLanguage: 'auto', ttsLanguage: 'hi-IN' }, 'auto', 'hi-IN'],
    [{}, undefined, undefined],
  ] as const)('languages %j -> stt %s / tts %s (per-leg overrides the shared one)', async (cfg, sttLang, ttsLang) => {
    const h = pipeline({ config: cfg as Partial<StartConfig> });
    await h.session.start();
    expect(h.stt.opts!.language).toBe(sttLang);
    const { tts } = await textTurn(h, 'hi');
    expect(tts.opts.language).toBe(ttsLang);
  });

  it('passes voice, model, canonical rate and credentials to TTS, and model/temperature/credentials to the LLM', async () => {
    const h = pipeline({ config: { voice: 'beep', temperature: 0.3 } });
    await h.session.start();
    const { tts, llm } = await textTurn(h, 'hi');
    expect(tts.opts).toEqual({ model: 'tts-m', voice: 'beep', language: undefined, sampleRate: 24000, credentials: h.credentials });
    expect(llm.opts).toEqual({ model: 'llm-m', temperature: 0.3, credentials: h.credentials });
  });

  it('audio pushed before start() resolves is neither forwarded nor billed', async () => {
    const h = pipeline();
    h.session.pushAudio(quiet(5));
    await h.session.start();
    expect(h.stt.pushed).toEqual([]);
    h.session.pushAudio(quiet(2));
    h.stt.ev.onSpeechEnd!();
    h.stt.ev.onFinal('hello');
    await tick();
    h.llm[0].reply(['x']);
    h.tts[0].ev.onDone();
    expect(sttSeconds(h.rec.usage[0])).toBe(2);
  });

  it('forwards every mic chunk to the STT leg unchanged and in order', async () => {
    const h = pipeline();
    await h.session.start();
    const a = loud(0.1);
    const b = quiet(0.2);
    h.session.pushAudio(a);
    h.session.pushAudio(b);
    expect(h.stt.pushed).toHaveLength(2);
    expect(h.stt.pushed[0]).toBe(a);
    expect(h.stt.pushed[1]).toBe(b);
  });
});

/* ================================ normal turn ================================ */

describe('a normal spoken turn', () => {
  async function scripted() {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(2));
    h.stt.ev.onPartial('hel'); // before any turn exists
    h.stt.ev.onSpeechEnd!(); // t0
    await vi.advanceTimersByTimeAsync(50);
    h.stt.ev.onPartial('hello wor');
    await vi.advanceTimersByTimeAsync(50);
    h.stt.ev.onFinal('hello world');
    await tick();
    const llm = h.llm[0];
    const tts = h.tts[0];
    await vi.advanceTimersByTimeAsync(200);
    llm.ev.onDelta('Hi ');
    await vi.advanceTimersByTimeAsync(50);
    const a1 = chunk(100);
    const a2 = chunk(100);
    tts.ev.onAudio(a1);
    llm.ev.onDelta('there.');
    tts.ev.onAudio(a2);
    llm.ev.onUsage!({ inputTokens: 20, outputTokens: 3, thinkingTokens: 1, cachedInputTokens: 4 });
    await vi.advanceTimersByTimeAsync(50);
    llm.ev.onDone('Hi there.');
    await vi.advanceTimersByTimeAsync(100);
    tts.ev.onDone();
    return { h, llm, tts, a1, a2 };
  }

  it('emits user transcripts with the right turn ids (0 before the turn exists)', async () => {
    const { h } = await scripted();
    expect(h.rec.of('user')).toEqual([
      { type: 'user', text: 'hel', final: false, turnId: 0 },
      { type: 'user', text: 'hello wor', final: false, turnId: 1 },
      { type: 'user', text: 'hello world', final: true, turnId: 1 },
    ]);
  });

  it('streams assistant text cumulatively, then a final', async () => {
    const { h } = await scripted();
    expect(h.rec.of('assistant')).toEqual([
      { type: 'assistant', text: 'Hi ', final: false, turnId: 1 },
      { type: 'assistant', text: 'Hi there.', final: false, turnId: 1 },
      { type: 'assistant', text: 'Hi there.', final: true, turnId: 1 },
    ]);
  });

  it('feeds every LLM delta to TTS as it arrives, flushes on done, closes at turn end', async () => {
    const { tts } = await scripted();
    expect(tts.texts).toEqual(['Hi ', 'there.']);
    expect(tts.flushes).toBe(1);
    expect(tts.closes).toBe(1);
    expect(tts.cancels).toBe(0);
  });

  it('forwards TTS audio untouched and in order', async () => {
    const { h, a1, a2 } = await scripted();
    expect(h.rec.audio).toHaveLength(2);
    expect(h.rec.audio[0]).toBe(a1);
    expect(h.rec.audio[1]).toBe(a2);
  });

  it('turn lifecycle order: start, end, metrics, usage — once each, no interrupt', async () => {
    const { h } = await scripted();
    expect(h.rec.sequence()).toEqual(['turn_start:1', 'turn_end:1', 'metrics:1', 'usage:1']);
    expect(h.rec.interrupts).toBe(0);
  });

  it('turn_start only fires once the transcript is known (a pending turn is not a turn yet)', async () => {
    const h = pipeline();
    await h.session.start();
    h.stt.ev.onSpeechEnd!();
    expect(h.rec.turnStarts).toEqual([]);
    h.stt.ev.onFinal('go');
    expect(h.rec.turnStarts).toEqual([1]);
  });

  it('marks every stage, in pipeline order, each exactly once', async () => {
    const { h } = await scripted();
    const m = h.rec.metrics[0];
    expect(m.turnId).toBe(1);
    expect(markNames(m)).toEqual([
      'user_speech_end',
      'stt_first_partial',
      'stt_final',
      'tts_request_sent',
      'llm_request_sent',
      'llm_first_token',
      'tts_first_audio',
      'first_audio_out',
      'llm_last_token',
      'last_audio_out',
    ]);
    const ats = m.marks.map((x) => x.atMs);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  it('every latency is measured from user_speech_end (t0)', async () => {
    const { h } = await scripted();
    const m = h.rec.metrics[0];
    expect(markAt(m, 'user_speech_end')).toBe(0);
    expect(markAt(m, 'stt_first_partial')).toBe(50);
    expect(markAt(m, 'stt_final')).toBe(100);
    expect(markAt(m, 'tts_request_sent')).toBe(100);
    expect(markAt(m, 'llm_request_sent')).toBe(100);
    expect(markAt(m, 'llm_first_token')).toBe(300);
    expect(markAt(m, 'tts_first_audio')).toBe(350);
    expect(markAt(m, 'llm_last_token')).toBe(400);
    expect(markAt(m, 'last_audio_out')).toBe(500);
    expect(m.derived).toEqual({
      timeToFirstAudioMs: 350,
      sttLatencyMs: 100,
      llmTtftMs: 200,
      ttsTtfbMs: 250,
      totalTurnMs: 500,
      audioDurationMs: 200,
    });
  });

  it('bills the turn in vendor units: STT seconds, LLM vendor tokens, TTS characters', async () => {
    const { h } = await scripted();
    expect(h.rec.usage).toEqual([
      {
        turnId: 1,
        legs: [
          { leg: 'stt', providerId: 'fake-stt', modelId: 'stt-m', unit: 'audio_seconds', inputUnits: 2, outputUnits: 0, source: 'local' },
          {
            leg: 'llm',
            providerId: 'fake-llm',
            modelId: 'llm-m',
            unit: 'tokens',
            inputUnits: 20,
            outputUnits: 3,
            thinkingTokens: 1,
            cachedInputTokens: 4,
            source: 'vendor',
          },
          {
            leg: 'tts',
            providerId: 'fake-tts',
            modelId: 'tts-m',
            unit: 'characters',
            inputUnits: 0,
            outputUnits: 'Hi there.'.length,
            audioSeconds: 0.2,
            source: 'local',
          },
        ],
      },
    ]);
  });

  it('tts_request_sent is marked BEFORE open(), so vendor connection setup is inside the TTS number', async () => {
    const h = pipeline({ tts: { openDelayMs: 300 } });
    await h.session.start();
    h.session.sendText('q');
    await vi.advanceTimersByTimeAsync(300);
    await tick();
    const tts = h.tts[0];
    const llm = h.llm[0];
    // The LLM leg is only started once the TTS socket is up.
    expect(llm).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    llm.ev.onDelta('a');
    tts.ev.onAudio(chunk(40));
    llm.ev.onDone('a');
    tts.ev.onDone();
    const m = h.rec.metrics[0];
    expect(markAt(m, 'tts_request_sent')).toBe(0);
    expect(markAt(m, 'llm_request_sent')).toBe(300);
    expect(m.derived.ttsTtfbMs).toBe(400);
    expect(m.derived.llmTtftMs).toBe(100);
    expect(m.derived.timeToFirstAudioMs).toBe(400);
  });

  it('first mark wins: repeated audio/partials/tokens do not move a mark', async () => {
    const h = pipeline();
    await h.session.start();
    h.stt.ev.onSpeechEnd!();
    await vi.advanceTimersByTimeAsync(10);
    h.stt.ev.onPartial('a');
    await vi.advanceTimersByTimeAsync(10);
    h.stt.ev.onPartial('a b');
    h.stt.ev.onFinal('a b c');
    await tick();
    await vi.advanceTimersByTimeAsync(10);
    h.llm[0].ev.onDelta('x');
    await vi.advanceTimersByTimeAsync(10);
    h.llm[0].ev.onDelta('y');
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 5; i++) {
      h.tts[0].ev.onAudio(chunk(20));
      await vi.advanceTimersByTimeAsync(10);
    }
    h.llm[0].ev.onDone('xy');
    h.tts[0].ev.onDone();
    const m = h.rec.metrics[0];
    expect(markAt(m, 'stt_first_partial')).toBe(10);
    expect(markAt(m, 'llm_first_token')).toBe(30);
    expect(markAt(m, 'tts_first_audio')).toBe(50);
    expect(markAt(m, 'first_audio_out')).toBe(50);
    expect(new Set(markNames(m)).size).toBe(m.marks.length);
    expect(m.derived.audioDurationMs).toBe(100);
  });

  it('a second speech-end signal for a pending turn is the same turn, and t0 stays at the first', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    h.stt.ev.onSpeechEnd!();
    await vi.advanceTimersByTimeAsync(300);
    h.session.pushAudio(quiet(0.5)); // after t0: belongs to the next turn
    h.stt.ev.onSpeechEnd!();
    h.session.commitAudio();
    await vi.advanceTimersByTimeAsync(100);
    h.stt.ev.onFinal('one');
    await tick();
    h.llm[0].reply(['ok']);
    h.tts[0].ev.onDone();
    expect(h.rec.turnStarts).toEqual([1]);
    expect(h.rec.metrics[0].derived.sttLatencyMs).toBe(400);
    expect(sttSeconds(h.rec.usage[0])).toBe(1);
    await h.session.close();
    expect(sttSeconds(h.rec.usage[1])).toBe(0.5); // the post-t0 audio became the tail
  });

  it('commitAudio() opens the turn (t0) and asks the STT leg to finalise', async () => {
    const h = pipeline({ config: { turnDetection: 'manual' } });
    await h.session.start();
    h.session.pushAudio(quiet(1));
    h.session.commitAudio();
    expect(h.stt.finalizes).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    h.stt.ev.onFinal('typed by voice');
    await tick();
    h.llm[0].reply(['k']);
    h.tts[0].ev.onDone();
    expect(h.rec.metrics[0].derived.sttLatencyMs).toBe(250);
    expect(sttSeconds(h.rec.usage[0])).toBe(1);
  });

  it('sendText() runs a turn with t0 = stt_final = now and no STT latency', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'typed');
    expect(h.rec.of('user')).toEqual([{ type: 'user', text: 'typed', final: true, turnId: 1 }]);
    llm.reply(['r']);
    tts.ev.onDone();
    expect(h.rec.metrics[0].derived.sttLatencyMs).toBe(0);
  });

  it('sendText() ignores blank text', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.sendText('   ');
    await tick();
    expect(h.llm).toEqual([]);
    expect(h.rec.turnStarts).toEqual([]);
  });

  it('a TTS onDone that arrives twice ends the turn once', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['a']);
    tts.ev.onDone();
    tts.ev.onDone();
    tts.ev.onError(new Error('late'));
    expect(h.rec.turnEnds).toEqual([1]);
    expect(h.rec.metrics).toHaveLength(1);
    expect(h.rec.usage).toHaveLength(1);
  });

  it('turn ids are sequential across turns and starts/ends stay balanced', async () => {
    const h = pipeline();
    await h.session.start();
    for (const q of ['a', 'b', 'c']) {
      const { llm, tts } = await spokenTurn(h, q);
      llm.reply([q.toUpperCase()]);
      tts.ev.onDone();
    }
    expect(h.rec.turnStarts).toEqual([1, 2, 3]);
    expect(h.rec.turnEnds).toEqual([1, 2, 3]);
    expect(h.rec.metrics.map((m) => m.turnId)).toEqual([1, 2, 3]);
    expect(h.rec.usage.map((u) => u.turnId)).toEqual([1, 2, 3]);
    // Each turn gets its own clock.
    for (const m of h.rec.metrics) expect(markAt(m, 'user_speech_end')).toBe(0);
  });
});

/* ============================== pending / abandoned ============================== */

describe('pending turns: abandoned without billing, audio handed back', () => {
  it('an empty final abandons the pending turn: no turn start, no usage, id not burned', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(3));
    h.stt.ev.onSpeechEnd!();
    h.stt.ev.onFinal('');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.rec.turnStarts).toEqual([]);
    expect(h.rec.usage).toEqual([]);
    expect(h.llm).toEqual([]);
    expect(h.tts).toEqual([]);

    const { llm, tts } = await spokenTurn(h, 'real', 4);
    llm.reply(['x']);
    tts.ev.onDone();
    expect(h.rec.turnStarts).toEqual([1]);
    expect(h.rec.usage.map((u) => u.turnId)).toEqual([1]);
    expect(sttSeconds(h.rec.usage[0])).toBe(7); // the silence's 3s + its own 4s
  });

  it.each(['', ' ', '\n\t  '])('whitespace-only final %j counts as silence', async (text) => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    h.stt.ev.onSpeechEnd!();
    h.stt.ev.onFinal(text);
    expect(h.rec.of('user').filter((u) => u.final)).toEqual([]);
    await h.session.close();
    expect(h.rec.usage).toEqual([{ turnId: 1, legs: [expect.objectContaining({ leg: 'stt', inputUnits: 1 })] }]);
  });

  it('several false endpoints in a row all roll forward into the next real turn, nothing lost or doubled', async () => {
    const h = pipeline();
    await h.session.start();
    for (const s of [1, 2, 0.5]) {
      h.session.pushAudio(quiet(s));
      h.stt.ev.onSpeechEnd!();
      h.stt.ev.onFinal('  ');
    }
    const t1 = await spokenTurn(h, 'q1', 1.5);
    t1.llm.reply(['a']);
    t1.tts.ev.onDone();
    const t2 = await spokenTurn(h, 'q2', 2);
    t2.llm.reply(['b']);
    t2.tts.ev.onDone();
    expect(h.rec.usage.map((u) => [u.turnId, sttSeconds(u)])).toEqual([
      [1, 5],
      [2, 2],
    ]);
  });

  it('t0 is not frozen by an abandoned turn: the next turn starts its own clock', async () => {
    const h = pipeline();
    await h.session.start();
    h.stt.ev.onSpeechEnd!();
    await vi.advanceTimersByTimeAsync(5000);
    h.stt.ev.onFinal('');
    await vi.advanceTimersByTimeAsync(1000);
    h.stt.ev.onSpeechEnd!();
    await vi.advanceTimersByTimeAsync(120);
    h.stt.ev.onFinal('hi');
    await tick();
    h.llm[0].reply(['x']);
    h.tts[0].ev.onDone();
    expect(h.rec.metrics[0].derived.sttLatencyMs).toBe(120);
    expect(h.rec.metrics[0].derived.totalTurnMs).toBe(120);
  });

  it('interrupt() on a pending turn abandons it silently: no turn_end, no onInterrupt, no usage', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    h.stt.ev.onSpeechEnd!();
    h.session.interrupt();
    expect(h.rec.log.filter((e) => e.type !== 'log')).toEqual([]);
    // The transcript that then arrives opens a fresh turn 1 carrying that audio.
    h.stt.ev.onFinal('hello');
    await tick();
    h.llm[0].reply(['x']);
    h.tts[0].ev.onDone();
    expect(h.rec.usage.map((u) => [u.turnId, sttSeconds(u)])).toEqual([[1, 1]]);
  });

  it('audio streamed while a turn is pending belongs to the NEXT turn (attribution is fixed at t0)', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    h.stt.ev.onSpeechEnd!();
    h.session.pushAudio(quiet(2));
    h.stt.ev.onFinal('one');
    await tick();
    h.llm[0].reply(['x']);
    h.tts[0].ev.onDone();
    const t2 = await spokenTurn(h, 'two', 0.5);
    t2.llm.reply(['y']);
    t2.tts.ev.onDone();
    expect(h.rec.usage.map(sttSeconds)).toEqual([1, 2.5]);
  });

  it('an empty final with no turn open does nothing', async () => {
    const h = pipeline();
    await h.session.start();
    h.stt.ev.onFinal('');
    expect(h.rec.log.filter((e) => e.type !== 'log')).toEqual([]);
  });

  it('an empty final while a turn is running leaves that turn alone', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    h.stt.ev.onFinal('');
    llm.reply(['a']);
    tts.ev.onDone();
    expect(h.rec.sequence()).toEqual(['turn_start:1', 'turn_end:1', 'metrics:1', 'usage:1']);
  });

  it('close() with a pending turn abandons it and reports its audio as the tail', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(2));
    h.stt.ev.onSpeechEnd!();
    await h.session.close();
    expect(h.rec.turnStarts).toEqual([]);
    expect(h.rec.usage).toEqual([{ turnId: 1, legs: [expect.objectContaining({ leg: 'stt', inputUnits: 2 })] }]);
  });
});

/* ================================== barge-in ================================== */

describe('barge-in', () => {
  async function speakingTurn() {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    const { llm, tts } = await spokenTurn(h, 'question');
    llm.ev.onDelta('a long ');
    tts.ev.onAudio(chunk(200));
    return { h, llm, tts };
  }

  it('an STT partial while speaking cancels TTS, aborts the LLM, raises onInterrupt then turn_end', async () => {
    const { h, llm, tts } = await speakingTurn();
    h.stt.ev.onPartial('wait');
    expect(tts.cancels).toBe(1);
    expect(llm.aborts).toBe(1);
    expect(h.rec.sequence()).toEqual(['turn_start:1', 'interrupt', 'turn_end:1']);
    expect(h.rec.metrics).toEqual([]); // cut off: no completed-turn metrics
  });

  it('cancel and abort are synchronous: both have happened by the time onInterrupt fires', async () => {
    const { h, llm, tts } = await speakingTurn();
    let seen: [number, number] | undefined;
    h.rec.onInterruptHook = () => (seen = [tts.cancels, llm.aborts]);
    h.session.interrupt();
    expect(seen).toEqual([1, 1]);
  });

  it('explicit interrupt() behaves the same, and a second interrupt() is a no-op', async () => {
    const { h, tts } = await speakingTurn();
    h.session.interrupt();
    h.session.interrupt();
    expect(tts.cancels).toBe(1);
    expect(h.rec.interrupts).toBe(1);
    expect(h.rec.turnEnds).toEqual([1]);
  });

  it('interrupt() while idle emits nothing', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.interrupt();
    expect(h.rec.log.filter((e) => e.type !== 'log')).toEqual([]);
  });

  it('interrupt() after the turn has finished emits nothing', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['a']);
    tts.ev.onDone();
    const n = h.rec.log.length;
    h.session.interrupt();
    expect(h.rec.log).toHaveLength(n);
    expect(tts.cancels).toBe(0);
  });

  it('a cut-off turn whose LLM had finished is billed immediately, with vendor tokens and every char sent', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    const { llm, tts } = await spokenTurn(h, 'q', 0);
    llm.reply(['abc ', 'def'], { inputTokens: 9, outputTokens: 2 });
    tts.ev.onAudio(chunk(100));
    h.stt.ev.onPartial('stop');
    expect(h.rec.usage).toHaveLength(1);
    const u = h.rec.usage[0];
    expect(leg(u, 'llm')).toMatchObject({ inputUnits: 9, outputUnits: 2, source: 'vendor' });
    expect(leg(u, 'tts')).toMatchObject({ outputUnits: 7 });
    expect(sttSeconds(u)).toBe(1);
  });

  it('a cut-off turn whose LLM had not finished waits the grace period, then bills a local estimate', async () => {
    const { h } = await speakingTurn();
    h.session.interrupt();
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(h.rec.usage).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.rec.usage).toHaveLength(1);
    const l = leg(h.rec.usage[0], 'llm')!;
    expect(l.source).toBe('local');
    expect(l.outputUnits).toBe(Math.round('a long '.length / 4));
    expect(leg(h.rec.usage[0], 'tts')!.outputUnits).toBe('a long '.length);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.rec.usage).toHaveLength(1);
  });

  it('vendor counts that land inside the grace period replace the estimate, and bill at once', async () => {
    const { h, llm } = await speakingTurn();
    h.session.interrupt();
    await vi.advanceTimersByTimeAsync(200);
    llm.ev.onUsage!({ inputTokens: 70, outputTokens: 5 });
    llm.ev.onDone('a long ');
    expect(h.rec.usage).toHaveLength(1);
    expect(leg(h.rec.usage[0], 'llm')).toMatchObject({ inputUnits: 70, outputUnits: 5, source: 'vendor' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.rec.usage).toHaveLength(1);
  });

  it('a partial while NOT speaking is not a barge-in', async () => {
    const h = pipeline();
    await h.session.start();
    h.stt.ev.onPartial('just talking');
    h.stt.ev.onSpeechEnd!();
    h.stt.ev.onPartial('still');
    expect(h.rec.interrupts).toBe(0);
    expect(h.rec.turnEnds).toEqual([]);
  });

  it('after a barge-in the next utterance becomes turn 2 and its audio is its own', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    const t1 = await spokenTurn(h, 'q1', 0);
    t1.llm.reply(['answer one']);
    t1.tts.ev.onAudio(chunk(40));
    h.stt.ev.onPartial('no wait'); // barge-in; LLM had settled, so billed at once
    const t2 = await spokenTurn(h, 'q2', 2);
    t2.llm.reply(['answer two']);
    t2.tts.ev.onDone();
    expect(h.rec.usage.map((u) => [u.turnId, sttSeconds(u)])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(h.rec.turnStarts).toEqual([1, 2]);
    expect(h.rec.turnEnds).toEqual([1, 2]);
    expect(t1.tts.cancels).toBe(1);
    expect(t2.tts.closes).toBe(1);
  });

  it('a speech end over a live answer is barge-in too, whatever the transport', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['done']);
    tts.ev.onAudio(chunk(40));
    h.stt.ev.onSpeechEnd!();
    expect(tts.cancels).toBe(1);
    // interrupt() bills (the LLM had settled) before it announces the cut.
    expect(h.rec.sequence()).toEqual(['turn_start:1', 'usage:1', 'interrupt', 'turn_end:1']);
  });

  it('commitAudio() over a live answer is barge-in too', async () => {
    const h = pipeline({ config: { turnDetection: 'manual' } });
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['done']);
    h.session.commitAudio();
    expect(tts.cancels).toBe(1);
    expect(h.rec.interrupts).toBe(1);
  });
});

/* ============================== overlapping turns ============================== */

describe('overlapping turns', () => {
  it('a second question mid-answer (LLM finished) is its own turn with its own tokens', async () => {
    const h = pipeline();
    await h.session.start();
    const t1 = await textTurn(h, 'first');
    t1.llm.reply(['one'], { inputTokens: 100, outputTokens: 10 });
    const t2 = await textTurn(h, 'second');
    t2.llm.reply(['two'], { inputTokens: 200, outputTokens: 20 });
    t2.tts.ev.onDone();
    expect(h.rec.usage.map((u) => [u.turnId, leg(u, 'llm')!.inputUnits, leg(u, 'llm')!.outputUnits])).toEqual([
      [1, 100, 10],
      [2, 200, 20],
    ]);
    expect(h.rec.turnStarts).toEqual([1, 2]);
    expect(h.rec.turnEnds).toEqual([1, 2]);
    expect(h.rec.of('user').map((u) => u.turnId)).toEqual([1, 2]);
  });

  it('late events from the superseded turn are ignored: no stray transcript, text, usage or turn end', async () => {
    const h = pipeline();
    await h.session.start();
    const t1 = await textTurn(h, 'first');
    t1.llm.reply(['one']);
    const t2 = await textTurn(h, 'second');
    const before = h.rec.log.length;
    // turn 1's legs keep talking after they were cancelled/aborted
    t1.llm.ev.onDelta('zombie');
    t1.llm.ev.onUsage!({ inputTokens: 999, outputTokens: 999 });
    t1.llm.ev.onDone('zombie');
    t1.tts.ev.onDone();
    expect(h.rec.log.slice(before).filter((e) => e.type !== 'audio')).toEqual([]);
    expect(t2.tts.texts).toEqual([]);
    t2.llm.reply(['two']);
    t2.tts.ev.onDone();
    expect(leg(h.rec.usage[1], 'llm')!.source).toBe('local');
    expect(h.rec.turnEnds).toEqual([1, 2]);
  });

  /*
   * The first turn's LLM has not settled, so its interrupt() only schedules a
   * drain; beginTurn() bills it at once instead, so the new input opens turn 2
   * rather than falling into the "already pending" early return on turn 1.
   */
  it('a second typed question while the first answer is still streaming opens turn 2', async () => {
    const h = pipeline();
    await h.session.start();
    const t1 = await textTurn(h, 'first');
    t1.llm.ev.onDelta('still going');
    const t2 = await textTurn(h, 'second');
    expect(h.rec.turnStarts).toEqual([1, 2]);
    expect(h.rec.of('user').map((u) => u.turnId)).toEqual([1, 2]);
    t2.llm.reply(['two']);
    await vi.advanceTimersByTimeAsync(GRACE);
    t2.tts.ev.onDone();
    expect(h.rec.turnEnds).toEqual([1, 2]);
  });

  /*
   * Same path: the speech end opens the next turn, so its t0 is the speech end,
   * not the moment its transcript arrives — otherwise every latency number for
   * that turn is understated by the STT leg's whole endpointing delay.
   */
  it('a speech end over a still-streaming answer sets t0 for the next turn', async () => {
    const h = pipeline();
    await h.session.start();
    const t1 = await textTurn(h, 'first');
    t1.llm.ev.onDelta('still going');
    h.stt.ev.onSpeechEnd!();
    await vi.advanceTimersByTimeAsync(400);
    h.stt.ev.onFinal('second');
    await tick();
    const t2 = h.llm[1];
    t2.reply(['two']);
    h.tts[1].ev.onDone();
    const m = h.rec.metrics.find((x) => x.turnId === 2)!;
    expect(m.derived.sttLatencyMs).toBe(400);
  });

  /*
   * runTurn() re-checks the turn once the TTS handshake resolves: a barge-in
   * during it (100s of ms for socket vendors) cancels the fresh stream and
   * never starts the LLM, so nothing speaks after the user has cut in.
   */
  it('a barge-in while TTS is still connecting does not start that turn’s LLM', async () => {
    const h = pipeline({ tts: { openDelayMs: 200 } });
    await h.session.start();
    h.session.sendText('q');
    await vi.advanceTimersByTimeAsync(50);
    h.session.interrupt();
    await vi.advanceTimersByTimeAsync(200);
    await tick();
    expect(h.llm).toHaveLength(0);
  });
});

/* ================================== failures ================================== */

describe('failures', () => {
  it('TTS error mid-answer: surfaced, turn ends with metrics, LLM aborted, usage waits for vendor counts', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.ev.onDelta('partial answer');
    tts.ev.onAudio(chunk(100));
    tts.ev.onError(new Error('vendor exploded'));
    expect(h.rec.errors.map((e) => e.message)).toEqual(['vendor exploded']);
    expect(h.rec.sequence()).toEqual(['turn_start:1', 'error', 'turn_end:1', 'metrics:1']);
    expect(llm.aborts).toBe(1);
    expect(tts.closes).toBe(1);
    expect(h.rec.interrupts).toBe(0); // a failure is not a barge-in
    llm.ev.onUsage!({ inputTokens: 900, outputTokens: 350, thinkingTokens: 300 });
    llm.ev.onDone('partial answer');
    expect(h.rec.usage).toHaveLength(1);
    expect(leg(h.rec.usage[0], 'llm')).toMatchObject({ inputUnits: 900, outputUnits: 350, thinkingTokens: 300, source: 'vendor' });
    expect(leg(h.rec.usage[0], 'tts')!.audioSeconds).toBe(0.1);
  });

  it('TTS error with a silent LLM: billed as a local estimate after exactly the grace period', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.ev.onDelta('some answer text');
    tts.ev.onAudio(chunk(40));
    tts.ev.onError(new Error('down'));
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(h.rec.usage).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(leg(h.rec.usage[0], 'llm')).toMatchObject({ source: 'local', outputUnits: Math.round(16 / 4) });
    expect(leg(h.rec.usage[0], 'tts')).toMatchObject({ outputUnits: 16, audioSeconds: 0.04 });
  });

  it('TTS error after the LLM has finished: usage is immediate', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['done'], { inputTokens: 1, outputTokens: 1 });
    tts.ev.onError(new Error('x'));
    expect(h.rec.sequence()).toEqual(['turn_start:1', 'error', 'turn_end:1', 'metrics:1', 'usage:1']);
  });

  it('TTS open() rejecting: surfaced, turn ends, the LLM is never called, billed after the grace period', async () => {
    const h = pipeline({ tts: { openError: new Error('handshake refused') } });
    await h.session.start();
    h.session.pushAudio(quiet(1));
    h.session.sendText('q');
    await tick();
    expect(h.rec.errors.map((e) => e.message)).toEqual(['handshake refused']);
    expect(h.rec.sequence()).toEqual(['turn_start:1', 'error', 'turn_end:1', 'metrics:1']);
    expect(h.llm).toEqual([]);
    expect(markNames(h.rec.metrics[0])).toEqual(['user_speech_end', 'stt_final', 'tts_request_sent', 'last_audio_out']);
    expect(h.rec.metrics[0].derived.timeToFirstAudioMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(h.rec.usage).toHaveLength(1);
    expect(leg(h.rec.usage[0], 'llm')).toMatchObject({ inputUnits: 0, outputUnits: 0, source: 'local' });
    expect(leg(h.rec.usage[0], 'tts')).toMatchObject({ outputUnits: 0, audioSeconds: undefined });
    expect(sttSeconds(h.rec.usage[0])).toBe(1);
  });

  it('LLM stream() throwing synchronously: surfaced, TTS closed, turn ends', async () => {
    const h = pipeline({ llm: { throwOnStream: new Error('bad request') } });
    await h.session.start();
    h.session.sendText('q');
    await tick();
    expect(h.rec.errors.map((e) => e.message)).toEqual(['bad request']);
    expect(h.rec.turnEnds).toEqual([1]);
    expect(h.tts[0].closes).toBe(1);
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(h.rec.usage).toHaveLength(1);
  });

  it('LLM error mid-stream: surfaced, TTS flushed so what was said finishes, billed locally, no assistant history', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.ev.onDelta('half');
    llm.ev.onError(new Error('llm down'));
    expect(h.rec.errors.map((e) => e.message)).toEqual(['llm down']);
    expect(tts.flushes).toBe(1);
    expect(h.rec.turnEnds).toEqual([]); // the TTS leg still has to finish speaking
    tts.ev.onDone();
    expect(h.rec.turnEnds).toEqual([1]);
    expect(h.rec.usage).toHaveLength(1); // settled by the error, so no grace wait
    expect(leg(h.rec.usage[0], 'llm')).toMatchObject({ source: 'local', outputUnits: 1 });
    const next = await textTurn(h, 'again');
    expect(next.llm.messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('STT error is surfaced and the session keeps working', async () => {
    const h = pipeline();
    await h.session.start();
    h.stt.ev.onError(new Error('stt hiccup'));
    expect(h.rec.errors.map((e) => e.message)).toEqual(['stt hiccup']);
    const { llm, tts } = await spokenTurn(h, 'still here');
    llm.reply(['yes']);
    tts.ev.onDone();
    expect(h.rec.turnEnds).toEqual([1]);
  });

  it('STT error mid-answer does not end the answer', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    h.stt.ev.onError(new Error('stt hiccup'));
    expect(tts.cancels).toBe(0);
    llm.reply(['a']);
    tts.ev.onDone();
    expect(h.rec.turnEnds).toEqual([1]);
  });
});

/* =================================== history =================================== */

describe('conversation history', () => {
  it('accumulates system, user, assistant in order; each LLM call sees everything before it', async () => {
    const h = pipeline({ config: { systemPrompt: 'Be brief.' } });
    await h.session.start();
    const replies = ['A1', 'A2', 'A3'];
    for (let i = 0; i < 3; i++) {
      const { llm, tts } = await spokenTurn(h, `U${i + 1}`);
      llm.reply([replies[i]]);
      tts.ev.onDone();
    }
    expect(h.llm.map((c) => c.messages)).toEqual([
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'U1' },
      ],
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
      ],
      [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U2' },
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'U3' },
      ],
    ]);
  });

  it.each(['', '   ', '\n'])('a blank system prompt (%j) adds no system message', async (systemPrompt) => {
    const h = pipeline({ config: { systemPrompt } });
    await h.session.start();
    const { llm } = await textTurn(h, 'hi');
    expect(llm.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('onDone with empty full text keeps the streamed text as the answer', async () => {
    const h = pipeline();
    await h.session.start();
    const t1 = await textTurn(h, 'q');
    t1.llm.ev.onDelta('streamed ');
    t1.llm.ev.onDelta('reply');
    t1.llm.ev.onDone('');
    t1.tts.ev.onDone();
    expect(h.rec.of('assistant').at(-1)).toEqual({ type: 'assistant', text: 'streamed reply', final: true, turnId: 1 });
    const t2 = await textTurn(h, 'q2');
    expect(t2.llm.messages.at(-2)).toEqual({ role: 'assistant', content: 'streamed reply' });
  });

  it('onDone full text wins over the streamed deltas (vendors may normalise)', async () => {
    const h = pipeline();
    await h.session.start();
    const t1 = await textTurn(h, 'q');
    t1.llm.ev.onDelta('draft');
    t1.llm.ev.onDone('Final.');
    t1.tts.ev.onDone();
    const t2 = await textTurn(h, 'q2');
    expect(t2.llm.messages.at(-2)).toEqual({ role: 'assistant', content: 'Final.' });
    expect(h.rec.of('assistant').at(-1)).toEqual({ type: 'assistant', text: 'Final.', final: true, turnId: 1 });
  });

  it('a barged-in answer that never finished leaves the user turn and no assistant message', async () => {
    const h = pipeline();
    await h.session.start();
    const t1 = await textTurn(h, 'first');
    t1.llm.ev.onDelta('half an ans');
    h.session.interrupt();
    await vi.advanceTimersByTimeAsync(GRACE);
    const t2 = await textTurn(h, 'second');
    expect(t2.llm.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('an abandoned (silent) turn adds nothing to history', async () => {
    const h = pipeline();
    await h.session.start();
    h.stt.ev.onSpeechEnd!();
    h.stt.ev.onFinal('');
    const { llm } = await spokenTurn(h, 'only');
    expect(llm.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'only' },
    ]);
  });
});

/* ==================================== usage ==================================== */

describe('usage accounting', () => {
  it('local LLM estimate is ~4 chars/token over the whole prompt and the full reply, flagged local', async () => {
    const h = pipeline({ config: { systemPrompt: 'S'.repeat(40) } });
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'U'.repeat(22));
    llm.reply(['R'.repeat(10), 'R'.repeat(9)]);
    tts.ev.onDone();
    const l = leg(h.rec.usage[0], 'llm')!;
    expect(l).toEqual({
      leg: 'llm',
      providerId: 'fake-llm',
      modelId: 'llm-m',
      unit: 'tokens',
      inputUnits: Math.round(62 / 4),
      outputUnits: Math.round(19 / 4),
      source: 'local',
    });
    expect(l.thinkingTokens).toBeUndefined();
    expect(l.cachedInputTokens).toBeUndefined();
  });

  it('the local input estimate grows with history (the whole prompt is billed every turn)', async () => {
    const h = pipeline({ config: { systemPrompt: '' } });
    await h.session.start();
    const t1 = await textTurn(h, 'aaaa');
    t1.llm.reply(['bbbbbbbb']);
    t1.tts.ev.onDone();
    const t2 = await textTurn(h, 'cccc');
    t2.llm.reply(['d']);
    t2.tts.ev.onDone();
    expect(h.rec.usage.map((u) => leg(u, 'llm')!.inputUnits)).toEqual([1, 4]);
  });

  it('vendor usage with missing fields reports 0, never undefined, and is still vendor-sourced', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['a'], { outputTokens: 5 });
    tts.ev.onDone();
    expect(leg(h.rec.usage[0], 'llm')).toMatchObject({ inputUnits: 0, outputUnits: 5, source: 'vendor' });
  });

  it('the last vendor usage report for a turn wins', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.ev.onUsage!({ inputTokens: 1, outputTokens: 1 });
    llm.ev.onUsage!({ inputTokens: 10, outputTokens: 7 });
    llm.ev.onDone('a');
    tts.ev.onDone();
    expect(leg(h.rec.usage[0], 'llm')).toMatchObject({ inputUnits: 10, outputUnits: 7 });
  });

  it('TTS characters are what was pushed to the vendor, unaffected by onDone rewriting the text', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.ev.onDelta('12345');
    llm.ev.onDelta('678');
    llm.ev.onDone('a much longer normalised reply');
    tts.ev.onDone();
    expect(leg(h.rec.usage[0], 'tts')!.outputUnits).toBe(8);
  });

  it('a stream that reports billableCharacters() is billed that, not the pushed count', async () => {
    const h = pipeline({ tts: { billable: () => 3 } });
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['hello world']);
    tts.ev.onDone();
    expect(leg(h.rec.usage[0], 'tts')!.outputUnits).toBe(3);
  });

  /*
   * The turn keeps its own TTS stream, so billableCharacters() is consulted
   * even after interrupt() has cancelled it: a one-shot vendor (GeminiTtsProvider,
   * which only sends on flush) that never made its request is billed nothing —
   * the exact case types.ts documents billableCharacters for.
   */
  it('barge-in before a one-shot TTS flushed bills the 0 chars it sent', async () => {
    const h = pipeline({ tts: { billable: (c) => (c.flushes ? c.texts.join('').length : 0) } });
    await h.session.start();
    const { llm } = await textTurn(h, 'q');
    llm.ev.onDelta('Hello there');
    h.session.interrupt();
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(leg(h.rec.usage[0], 'tts')!.outputUnits).toBe(0);
  });

  /*
   * A drain already waiting keeps the audio duration its first request gave
   * it: a TTS failure followed by the user speaking within the grace period
   * (whose interrupt() knows no duration) still bills the TTS audioSeconds.
   */
  it('a pending drain preempted by the next turn keeps its TTS audioSeconds', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.ev.onDelta('partial');
    tts.ev.onAudio(chunk(100));
    tts.ev.onError(new Error('tts died')); // drain now waits on the LLM
    h.stt.ev.onSpeechEnd!(); // user talks again inside the grace period
    expect(h.rec.usage).toHaveLength(1);
    expect(leg(h.rec.usage[0], 'tts')!.audioSeconds).toBe(0.1);
  });

  it('TTS audioSeconds is the duration of audio emitted, rounded to ms', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['a']);
    tts.ev.onAudio(Buffer.alloc(12345 * 2));
    tts.ev.onDone();
    expect(leg(h.rec.usage[0], 'tts')!.audioSeconds).toBe(Number((12345 / SR).toFixed(3)));
  });

  it('STT seconds are rounded to the millisecond', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(Buffer.alloc(12345 * 2));
    const { llm, tts } = await spokenTurn(h, 'q', 0);
    llm.reply(['a']);
    tts.ev.onDone();
    expect(sttSeconds(h.rec.usage[0])).toBe(Number((12345 / SR).toFixed(3)));
  });

  it('every usage row is unpriced raw counts with a source (costing happens above this layer)', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.reply(['a']);
    tts.ev.onDone();
    for (const l of h.rec.usage[0].legs as Array<LegUsage & Record<string, unknown>>) {
      expect(['vendor', 'local']).toContain(l.source);
      expect(Object.keys(l)).not.toContain('cost');
      expect(Object.keys(l)).not.toContain('usd');
    }
    expect(h.rec.usage[0].legs.map((l) => [l.leg, l.unit])).toEqual([
      ['stt', 'audio_seconds'],
      ['llm', 'tokens'],
      ['tts', 'characters'],
    ]);
  });

  it('exactly one usage record per turn, however many settle signals arrive', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'q');
    llm.ev.onDelta('x');
    tts.ev.onError(new Error('e'));
    llm.ev.onError(new Error('e2'));
    llm.ev.onDone('x');
    llm.ev.onUsage!({ inputTokens: 1 });
    h.session.interrupt();
    await vi.advanceTimersByTimeAsync(GRACE * 3);
    await h.session.close();
    expect(h.rec.usage.filter((u) => u.turnId === 1)).toHaveLength(1);
  });
});

/* ================================ tail and close ================================ */

describe('tail records and close()', () => {
  it('audio after the last turn is a tail record: next id, STT leg only, logged', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'hello');
    llm.reply(['hi']);
    tts.ev.onDone();
    h.session.pushAudio(quiet(30));
    await h.session.close();
    expect(h.rec.usage).toHaveLength(2);
    expect(h.rec.usage[1]).toEqual({
      turnId: 2,
      legs: [{ leg: 'stt', providerId: 'fake-stt', modelId: 'stt-m', unit: 'audio_seconds', inputUnits: 30, outputUnits: 0, source: 'local' }],
    });
    expect(h.rec.of('log').at(-1)).toEqual({
      type: 'log',
      level: 'info',
      message: '30.0s of audio reached fake-stt after the last turn; billed separately.',
    });
    expect(h.rec.turnStarts).toEqual([1]); // a tail is not a turn
  });

  it.each([
    [0.1, false],
    [0.249, false],
    [0.25, true],
    [1, true],
  ])('a %ss tail is recorded: %s', async (seconds, recorded) => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(seconds));
    await h.session.close();
    expect(h.rec.usage).toHaveLength(recorded ? 1 : 0);
  });

  it('a conversation with no turns at all still bills its audio as a tail (turn id 1)', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(2));
    await h.session.close();
    expect(h.rec.usage).toEqual([{ turnId: 1, legs: [expect.objectContaining({ leg: 'stt', inputUnits: 2 })] }]);
  });

  it('close() mid-answer (LLM settled) bills the cut-off turn, balances start/end, raises onInterrupt', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm, tts } = await textTurn(h, 'hello');
    llm.reply(['hi there'], { inputTokens: 100, outputTokens: 10 });
    tts.ev.onAudio(chunk(40));
    await h.session.close();
    expect(h.rec.usage.map((u) => u.turnId)).toEqual([1]);
    expect(h.rec.turnStarts).toEqual(h.rec.turnEnds);
    expect(h.rec.interrupts).toBe(1);
    expect(tts.cancels).toBe(1);
    expect(h.stt.closes).toBe(1);
  });

  /*
   * session-socket.ts finalize() reads ledger.summary() right after `await
   * session.close()`, so close() bills a cut-off turn at once rather than after
   * the LLM grace period — otherwise the record is saved without its last turn.
   */
  it('close() while the LLM is still streaming bills the turn before close() resolves', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm } = await textTurn(h, 'hello');
    llm.ev.onDelta('half');
    await h.session.close();
    expect(h.rec.usage.map((u) => u.turnId)).toContain(1);
  });

  it('close() while the LLM is still streaming does eventually bill the turn, once', async () => {
    const h = pipeline();
    await h.session.start();
    const { llm } = await textTurn(h, 'hello');
    llm.ev.onDelta('half');
    await h.session.close();
    await vi.advanceTimersByTimeAsync(GRACE);
    expect(h.rec.usage.filter((u) => u.turnId === 1)).toHaveLength(1);
    expect(h.rec.turnStarts).toEqual(h.rec.turnEnds);
  });

  it('close() is idempotent: a second close emits nothing and closes STT once', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1));
    await h.session.close();
    const n = h.rec.log.length;
    await h.session.close();
    expect(h.rec.log).toHaveLength(n);
    expect(h.stt.closes).toBe(1);
  });

  it('after close(), audio, text and commits are ignored', async () => {
    const h = pipeline();
    await h.session.start();
    await h.session.close();
    const pushed = h.stt.pushed.length;
    h.session.pushAudio(quiet(5));
    h.session.sendText('hello?');
    h.session.commitAudio();
    await tick();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.stt.pushed).toHaveLength(pushed);
    expect(h.stt.finalizes).toBe(0);
    expect(h.llm).toEqual([]);
    expect(h.rec.turnStarts).toEqual([]);
    await h.session.close();
    expect(h.rec.usage).toEqual([]); // the 5s pushed after close was never billed
  });

  it('close() before start() is harmless', async () => {
    const h = pipeline();
    await expect(h.session.close()).resolves.toBeUndefined();
    expect(h.rec.log).toEqual([]);
  });

  it('total STT audio is conserved across turns, abandonment and the tail', async () => {
    const h = pipeline();
    await h.session.start();
    h.session.pushAudio(quiet(1.25));
    h.stt.ev.onSpeechEnd!();
    h.stt.ev.onFinal('');
    const t1 = await spokenTurn(h, 'a', 0.75);
    h.session.pushAudio(quiet(0.5)); // during the answer
    t1.llm.reply(['x']);
    t1.tts.ev.onDone();
    const t2 = await spokenTurn(h, 'b', 1);
    t2.llm.ev.onDelta('y');
    h.stt.ev.onPartial('stop'); // barge-in
    h.session.pushAudio(quiet(3));
    await vi.advanceTimersByTimeAsync(GRACE);
    await h.session.close();
    const total = h.rec.usage.reduce((n, u) => n + (sttSeconds(u) ?? 0), 0);
    expect(total).toBeCloseTo(1.25 + 0.75 + 0.5 + 1 + 3, 6);
    expect(h.rec.usage.map((u) => [u.turnId, sttSeconds(u), u.legs.length])).toEqual([
      [1, 2, 3],
      [2, 1.5, 3],
      [3, 3, 1],
    ]);
  });
});

/* ============================ with the mock providers ============================ */

describe('end to end with the mock providers (via the factory)', () => {
  const CANNED0 = 'What is the weather like today';
  const reply = `You said: ${CANNED0}. This is the mock model replying so you can measure the transport, not the model.`;

  function mockSession(config: Partial<StartConfig> = {}) {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const rec = new Recorder();
    const session = createSession({
      sessionId: 'm1',
      config: {
        mode: 'pipeline',
        sttProviderId: 'mock-stt',
        llmProviderId: 'mock-llm',
        ttsProviderId: 'mock-tts',
        systemPrompt: 'Be brief.',
        turnDetection: 'server_vad',
        ...config,
      },
      events: rec,
      credentials: {},
    });
    return { session, rec };
  }
  /** Speak, then go quiet until the mock STT endpoints (16 x 40 ms > 600 ms). */
  function utterance(session: { pushAudio(b: Buffer): void }, speechSeconds = 0.5) {
    session.pushAudio(loud(speechSeconds));
    for (let i = 0; i < 16; i++) session.pushAudio(quiet(0.04));
  }
  const expectedAudio = (text: string) =>
    Buffer.concat(
      text
        .split(/\s+/)
        .filter(Boolean)
        .flatMap((w, i) => [tone(Math.min(240, 60 + w.length * 22), 180 + ((i * 37) % 160)), silence(50)]),
    );

  it('is a PipelineSession wired to the three mocks', () => {
    const { session } = mockSession();
    expect(session).toBeInstanceOf(PipelineSession);
    expect(session.label).toBe('mock-stt:mock-asr → mock-llm:mock-chat → mock-tts:mock-voice');
  });

  it('runs a full spoken turn: transcripts, PCM16 @ 24 kHz audio, metrics, local usage', async () => {
    const { session, rec } = mockSession();
    await session.start();
    utterance(session);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(rec.of('user').filter((u) => u.final)).toEqual([{ type: 'user', text: CANNED0, final: true, turnId: 1 }]);
    expect(rec.of('assistant').at(-1)).toEqual({ type: 'assistant', text: reply, final: true, turnId: 1 });
    expect(rec.sequence()).toEqual(['turn_start:1', 'turn_end:1', 'metrics:1', 'usage:1']);

    const audio = Buffer.concat(rec.audio);
    expect(audio.equals(expectedAudio(reply))).toBe(true);
    for (const b of rec.audio) {
      expect(b.length % 2).toBe(0);
      expect(b.length).toBeLessThanOrEqual(1920);
    }

    const m = rec.metrics[0];
    expect(markNames(m)[0]).toBe('user_speech_end');
    expect(m.derived.sttLatencyMs).toBe(0);
    expect(m.derived.llmTtftMs).toBe(180);
    // "You" waits for a word boundary, which the second token brings at 192 ms; then 90 ms TTFB.
    expect(m.derived.timeToFirstAudioMs).toBe(282);
    expect(m.derived.audioDurationMs).toBeCloseTo((audio.length / BYTES_PER_SECOND) * 1000, 0);

    const u = rec.usage[0];
    // 0.5s of speech + 15 quiet frames; the 16th frame triggered the endpoint and belongs to what follows.
    expect(sttSeconds(u)).toBe(1.1);
    expect(leg(u, 'llm')).toMatchObject({
      source: 'local',
      inputUnits: Math.round(('Be brief.'.length + CANNED0.length) / 4),
      outputUnits: Math.round(reply.length / 4),
    });
    expect(leg(u, 'tts')).toMatchObject({
      outputUnits: reply.length,
      audioSeconds: Number((audio.length / BYTES_PER_SECOND).toFixed(3)),
    });
  });

  it('barge-in with the mocks: speaking over the answer stops its audio and raises onInterrupt', async () => {
    const { session, rec } = mockSession();
    await session.start();
    utterance(session);
    await vi.advanceTimersByTimeAsync(400); // answer is playing
    expect(rec.audio.length).toBeGreaterThan(0);
    session.pushAudio(loud(0.1)); // mock STT emits a partial 250 ms later
    await vi.advanceTimersByTimeAsync(250);
    expect(rec.interrupts).toBe(1);
    expect(rec.turnEnds).toEqual([1]);
    const bytes = rec.audio.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(rec.audio.length).toBe(bytes); // nothing after the cut
    expect(rec.usage.map((u) => u.turnId)).toEqual([1]);
  });

  it('two consecutive turns with the mocks keep history and ids straight', async () => {
    const { session, rec } = mockSession();
    await session.start();
    utterance(session);
    await vi.advanceTimersByTimeAsync(20_000);
    utterance(session);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rec.turnStarts).toEqual([1, 2]);
    expect(rec.turnEnds).toEqual([1, 2]);
    expect(rec.usage.map((u) => u.turnId)).toEqual([1, 2]);
    // turn 2's prompt includes turn 1's exchange, so its local input estimate is larger
    expect(leg(rec.usage[1], 'llm')!.inputUnits).toBeGreaterThan(leg(rec.usage[0], 'llm')!.inputUnits);
    await session.close();
  });

  it('manual turn detection with the mocks: nothing until commitAudio()', async () => {
    const { session, rec } = mockSession({ turnDetection: 'manual' });
    await session.start();
    session.pushAudio(loud(0.5));
    for (let i = 0; i < 50; i++) session.pushAudio(quiet(0.04));
    await vi.advanceTimersByTimeAsync(2000);
    expect(rec.turnStarts).toEqual([]);
    session.commitAudio();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rec.turnStarts).toEqual([1]);
    expect(rec.turnEnds).toEqual([1]);
    expect(sttSeconds(rec.usage[0])).toBe(2.5);
  });

  it('committing silence with the mocks yields an empty final and no turn', async () => {
    const { session, rec } = mockSession({ turnDetection: 'manual' });
    await session.start();
    session.commitAudio();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rec.turnStarts).toEqual([]);
    expect(rec.usage).toEqual([]);
  });
});
