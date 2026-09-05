import type { RealtimeProvider, SessionContext, VoiceSession } from '../types.js';
import { CANONICAL_SAMPLE_RATE, type SessionMode } from '../../shared/protocol.js';
import { TurnMetrics } from '../../metrics/TurnMetrics.js';
import { pcm16DurationMs, rms, silence, tone } from '../../audio/pcm.js';

const FRAME_MS = 40;
const FRAME_BYTES = (FRAME_MS * CANONICAL_SAMPLE_RATE * 2) / 1000;

/**
 * Fake speech-to-speech provider: local VAD, then a single synthesised utterance.
 * Exists so the realtime code path can be exercised end to end with no vendor.
 */
class MockRealtimeSession implements VoiceSession {
  readonly mode: SessionMode = 'realtime';
  readonly label = 'mock-realtime:mock-s2s';

  private turnId = 0;
  /** Realtime providers bill on audio in both directions, not on tokens. */
  private inBytesPending = 0;
  /** The turn currently being spoken, so barge-in and close can still bill it. */
  private active?: { turnId: number; audioInSeconds: number; sentBytes: number; billed: boolean };
  private silentMs = 0;
  private sawSpeech = false;
  private speaking = false;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly id: string,
    private readonly ctx: SessionContext,
  ) {}

  async start(): Promise<void> {
    this.ctx.events.onLog('info', 'mock realtime session ready (local VAD, synthetic voice)');
  }

  pushAudio(chunk: Buffer): void {
    if (this.closed) return;
    this.inBytesPending += chunk.length;
    const loud = rms(chunk) > 0.01;

    if (loud) {
      if (this.speaking) this.interrupt(); // barge-in
      this.sawSpeech = true;
      this.silentMs = 0;
      return;
    }
    if (!this.sawSpeech) return;
    this.silentMs += pcm16DurationMs(chunk.length);
    if (this.ctx.config.turnDetection === 'server_vad' && this.silentMs > 600) {
      this.commitAudio();
    }
  }

  commitAudio(): void {
    if (this.closed || !this.sawSpeech) return;
    this.sawSpeech = false;
    this.silentMs = 0;
    this.ctx.events.onUserTranscript('(mock heard you speak)', true, this.turnId + 1);
    this.respond('I heard you. This is the mock speech-to-speech provider, so nothing left this machine.');
  }

  sendText(text: string): void {
    if (this.closed || !text.trim()) return;
    this.ctx.events.onUserTranscript(text, true, this.turnId + 1);
    this.respond(`You typed: ${text}. The mock realtime provider replies with a synthetic voice.`);
  }

  interrupt(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    // A cut-off answer still consumed audio in both directions. Without this,
    // barge-in — and close(), which is what ending a conversation does — loses
    // the entire turn, and the mocks are the reference for real providers.
    this.bill();
    if (this.speaking) {
      this.speaking = false;
      this.ctx.events.onTurnEnd(this.turnId);
    }
  }

  /** Emits the active turn's usage exactly once, however the turn ended. */
  private bill(): void {
    const a = this.active;
    if (!a || a.billed) return;
    a.billed = true;
    this.active = undefined;
    this.ctx.events.onUsage(a.turnId, [
      {
        leg: 'realtime',
        providerId: 'mock-realtime',
        modelId: this.ctx.config.realtimeModelId ?? 'mock-s2s',
        unit: 'audio_seconds',
        inputUnits: round(a.audioInSeconds, 3),
        outputUnits: round(pcm16DurationMs(a.sentBytes) / 1000, 3),
        source: 'local',
      },
    ]);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.interrupt();
  }

  private respond(text: string): void {
    const { events } = this.ctx;
    this.turnId += 1;
    const metrics = new TurnMetrics(this.turnId);
    metrics.mark('user_speech_end');
    this.speaking = true;
    events.onTurnStart(this.turnId);

    const audioInSeconds = pcm16DurationMs(this.inBytesPending) / 1000;
    this.inBytesPending = 0;
    const active = { turnId: this.turnId, audioInSeconds, sentBytes: 0, billed: false };
    this.active = active;

    const words = text.split(' ');
    const audio = Buffer.concat(
      words.flatMap((w, i) => [tone(Math.min(240, 60 + w.length * 22), 190 + ((i * 41) % 150)), silence(50)]),
    );

    let sent = 0;
    let shown = 0;
    // ~300ms first-token latency, then real-time playout
    this.timer = setTimeout(function pump(this: MockRealtimeSession) {
      if (!this.speaking) return;
      if (sent >= audio.length) {
        events.onAssistantTranscript(text, true, metrics.turnId);
        metrics.mark('last_audio_out');
        const snap = metrics.snapshot();
        this.speaking = false;
        events.onTurnEnd(metrics.turnId);
        events.onMetrics(metrics.turnId, snap.marks, snap.derived);
        this.bill();
        return;
      }
      const frame = audio.subarray(sent, Math.min(audio.length, sent + FRAME_BYTES));
      sent += frame.length;
      active.sentBytes = sent;
      metrics.mark('first_audio_out');
      metrics.countAudio(frame.length);
      events.onAudio(frame);

      const progress = sent / audio.length;
      const target = Math.ceil(progress * words.length);
      if (target > shown) {
        shown = target;
        events.onAssistantTranscript(words.slice(0, shown).join(' '), false, metrics.turnId);
      }
      this.timer = setTimeout(pump.bind(this), FRAME_MS);
    }.bind(this), 300);
  }
}

export class MockRealtimeProvider implements RealtimeProvider {
  readonly id = 'mock-realtime';
  readonly name = 'Mock (echo)';

  createSession(ctx: SessionContext): VoiceSession {
    return new MockRealtimeSession(ctx.sessionId, ctx);
  }
}

const round = (n: number, dp: number) => Number(n.toFixed(dp));
