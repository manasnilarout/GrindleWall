/**
 * Turn-attribution regression tests.
 *
 *   npm run turn:selftest
 *
 * Every case here is a bug that shipped and was caught in review. They drive
 * PipelineSession directly through fake providers, so a turn boundary can be
 * broken deliberately — a thing the WS smoke test cannot express.
 *
 * Needs no API key and touches no network.
 */
import { PipelineSession } from '../src/pipeline/PipelineSession.js';
import { MockRealtimeProvider } from '../src/providers/realtime/MockRealtimeProvider.js';
import type {
  LegUsage,
  MetricMark,
  DerivedMetrics,
  StartConfig,
} from '../src/shared/protocol.js';
import type {
  LlmEvents,
  LlmProvider,
  SessionEvents,
  SttEvents,
  SttProvider,
  TtsEvents,
  TtsProvider,
} from '../src/providers/types.js';

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, cond: boolean) => check(name, cond, true);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- controllable fakes ----------------------------- */

let stt!: SttEvents;
let tts!: TtsEvents;
/** Set by the fake LLM so a test can drive one turn's model by hand. */
const llmControl: Array<{ events: LlmEvents; aborted: boolean }> = [];

const fakeStt: SttProvider = {
  id: 'fake-stt',
  name: 'fake',
  async open(_opts, events) {
    stt = events;
    return { pushAudio() {}, finalize() {}, close() {} };
  },
};

const fakeTts: TtsProvider = {
  id: 'fake-tts',
  name: 'fake',
  async open(_opts, events) {
    tts = events;
    return { pushText() {}, flush() {}, cancel() {}, close() {} };
  },
};

/** Reports vendor usage only when told to, so both accounting paths are testable. */
function makeLlm(opts: { autoRespond: boolean; usage?: { inputTokens: number; outputTokens: number } }): LlmProvider {
  return {
    id: 'fake-llm',
    name: 'fake',
    stream(_o, _messages, events) {
      const entry = { events, aborted: false };
      llmControl.push(entry);
      if (opts.autoRespond) {
        queueMicrotask(() => {
          if (entry.aborted) return;
          events.onDelta('hello there');
          if (opts.usage) events.onUsage?.(opts.usage);
          events.onDone('hello there');
        });
      }
      return {
        abort() {
          entry.aborted = true;
        },
      };
    },
  };
}

interface Recorded {
  usage: Array<{ turnId: number; legs: LegUsage[] }>;
  metrics: Array<{ turnId: number; marks: MetricMark[]; derived: DerivedMetrics }>;
  turnStarts: number;
  turnEnds: number;
  errors: string[];
}

function harness(llm: LlmProvider) {
  llmControl.length = 0;
  const rec: Recorded = { usage: [], metrics: [], turnStarts: 0, turnEnds: 0, errors: [] };
  const events: SessionEvents = {
    onUserTranscript() {},
    onAssistantTranscript() {},
    onAudio() {},
    onTurnStart: () => void (rec.turnStarts += 1),
    onTurnEnd: () => void (rec.turnEnds += 1),
    onMetrics: (turnId, marks, derived) => void rec.metrics.push({ turnId, marks, derived }),
    onUsage: (turnId, legs) => void rec.usage.push({ turnId, legs }),
    onLog() {},
    onError: (err) => void rec.errors.push(err.message),
  };
  const config = { mode: 'pipeline', systemPrompt: 'Be brief.', turnDetection: 'server_vad' } as StartConfig;
  const session = new PipelineSession('t', { sessionId: 't', config, events, credentials: {} }, {
    stt: fakeStt, sttModel: 'm', llm, llmModel: 'm', tts: fakeTts, ttsModel: 'm',
  });
  return { session, rec };
}

/** 24 kHz PCM16: 48000 bytes per second. Silence — the STT fake ignores content. */
const audio = (seconds: number) => Buffer.alloc(Math.round(seconds * 24000 * 2));

/** The realtime mock runs a real energy VAD, so its input has to be audible. */
function loud(seconds: number): Buffer {
  const buf = audio(seconds);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(i % 2 ? 12000 : -12000, i * 2);
  return buf;
}
const sttSeconds = (u: { legs: LegUsage[] }) => u.legs.find((l) => l.leg === 'stt')?.inputUnits;
const llmLeg = (u: { legs: LegUsage[] }) => u.legs.find((l) => l.leg === 'llm')!;

/* ----------------------------------- tests ----------------------------------- */

console.log('\nAn empty STT final must not strand the turn (it froze t0 and shifted every later turn)');
{
  const { session, rec } = harness(makeLlm({ autoRespond: true }));
  await session.start();

  session.pushAudio(audio(3));
  stt.onSpeechEnd!();
  stt.onFinal('   '); // silence: no words came back

  session.pushAudio(audio(4));
  stt.onSpeechEnd!();
  stt.onFinal('first question');
  await sleep(30);
  tts.onDone();
  await sleep(30);

  session.pushAudio(audio(2));
  stt.onSpeechEnd!();
  stt.onFinal('second question');
  await sleep(30);
  tts.onDone();
  await sleep(30);

  check('two real turns are billed', rec.usage.map((u) => u.turnId), [1, 2]);
  check('turn 1 carries the silence plus its own audio', sttSeconds(rec.usage[0]), 7);
  check('turn 2 carries only its own audio', sttSeconds(rec.usage[1]), 2);
  ok('no audio is lost or double-counted', sttSeconds(rec.usage[0])! + sttSeconds(rec.usage[1])! === 9);
  await session.close();
}

console.log('\nAn interrupt before the transcript must not invent a turn');
{
  const { session, rec } = harness(makeLlm({ autoRespond: true }));
  await session.start();

  session.pushAudio(audio(1));
  stt.onSpeechEnd!();
  session.interrupt(); // user changed their mind before the words arrived
  stt.onFinal('hello');
  await sleep(30);
  tts.onDone();
  await sleep(30);

  check('exactly one turn', rec.usage.length, 1);
  check('and it keeps the audio', sttSeconds(rec.usage[0]), 1);
  await session.close();
}

console.log('\nA second question mid-answer must be its own turn, with its own tokens');
{
  const { session, rec } = harness(makeLlm({ autoRespond: true, usage: { inputTokens: 500, outputTokens: 40 } }));
  await session.start();

  session.sendText('first');
  await sleep(30);
  session.sendText('second'); // arrives before the first answer finishes
  await sleep(30);
  tts.onDone();
  await sleep(30);

  check('two turns, not one', rec.usage.map((u) => u.turnId), [1, 2]);
  check('turn 1 keeps its vendor tokens', [llmLeg(rec.usage[0]).inputUnits, llmLeg(rec.usage[0]).source], [500, 'vendor']);
  check('turn 2 keeps its own', [llmLeg(rec.usage[1]).inputUnits, llmLeg(rec.usage[1]).source], [500, 'vendor']);
  check('turn_start and turn_end stay balanced', rec.turnStarts, rec.turnEnds);
  await session.close();
}

console.log('\nA TTS failure must abort the model and still record what it billed');
{
  const { session, rec } = harness(makeLlm({ autoRespond: false }));
  await session.start();

  session.sendText('question');
  await sleep(30);
  const llm = llmControl[0];
  llm.events.onDelta('partial answer');
  tts.onError(new Error('vendor exploded')); // turn ends while the model is mid-flight

  ok('the model was aborted rather than left running', llm.aborted);
  check('no usage is emitted yet — it waits for the real counts', rec.usage.length, 0);

  // The vendor reports a beat later, as they do.
  llm.events.onUsage?.({ inputTokens: 900, outputTokens: 350, thinkingTokens: 300 });
  llm.events.onDone('partial answer');
  await sleep(30);

  check('one turn billed', rec.usage.length, 1);
  check('with the vendor numbers, not a 150x undercount', [llmLeg(rec.usage[0]).inputUnits, llmLeg(rec.usage[0]).outputUnits], [900, 350]);
  check('marked as vendor-reported', llmLeg(rec.usage[0]).source, 'vendor');
  ok('the TTS error was surfaced', rec.errors.includes('vendor exploded'));
  await session.close();
}

console.log('\nA model that never reports usage still bills, after the grace period');
{
  const { session, rec } = harness(makeLlm({ autoRespond: false }));
  await session.start();
  session.sendText('question');
  await sleep(30);
  llmControl[0].events.onDelta('some answer text');
  tts.onError(new Error('down'));
  await sleep(900); // longer than LLM_SETTLE_GRACE_MS

  check('the turn is still billed', rec.usage.length, 1);
  check('flagged as a local estimate', llmLeg(rec.usage[0]).source, 'local');
  ok('the estimate reflects what was generated', llmLeg(rec.usage[0]).outputUnits > 0);
  await session.close();
}

console.log('\nAudio is billed only once it reaches the vendor');
{
  const { session, rec } = harness(makeLlm({ autoRespond: true }));
  // Deliberately not started: no STT stream exists yet.
  session.pushAudio(audio(5));
  await session.start();
  session.pushAudio(audio(2));
  stt.onSpeechEnd!();
  stt.onFinal('hello');
  await sleep(30);
  tts.onDone();
  await sleep(30);

  check('audio pushed before the stream opened is not billed', sttSeconds(rec.usage[0]), 2);
  await session.close();
}

console.log('\nAudio streamed after the last turn is reported, not silently dropped');
{
  const { session, rec } = harness(makeLlm({ autoRespond: true }));
  await session.start();
  session.sendText('hello');
  await sleep(30);
  tts.onDone();
  await sleep(30);

  session.pushAudio(audio(30)); // mic left open, vendor still metering
  await session.close();
  await sleep(30);

  check('a tail record is emitted', rec.usage.length, 2);
  check('with the trailing seconds', sttSeconds(rec.usage[1]), 30);
  check('and only an STT leg, which is what marks it a tail', rec.usage[1].legs.length, 1);
  await session.close();
}

console.log('\nA trivial tail is not worth a record');
{
  const { session, rec } = harness(makeLlm({ autoRespond: true }));
  await session.start();
  session.sendText('hello');
  await sleep(30);
  tts.onDone();
  await sleep(30);
  session.pushAudio(audio(0.1));
  await session.close();
  await sleep(30);
  check('no tail record for 100ms', rec.usage.length, 1);
}

console.log('\nEnding mid-answer bills the partial turn');
{
  const { session, rec } = harness(makeLlm({ autoRespond: true, usage: { inputTokens: 100, outputTokens: 10 } }));
  await session.start();
  session.sendText('hello');
  await sleep(30);
  await session.close(); // what end_conversation does
  await sleep(30);

  check('the interrupted turn is billed', rec.usage.length, 1);
  check('turn_start and turn_end stay balanced', rec.turnStarts, rec.turnEnds);
}

console.log('\nRealtime: barge-in and close must still bill the turn (the mock is the reference provider)');
{
  const rec: Recorded = { usage: [], metrics: [], turnStarts: 0, turnEnds: 0, errors: [] };
  const events: SessionEvents = {
    onUserTranscript() {}, onAssistantTranscript() {}, onAudio() {},
    onTurnStart: () => void (rec.turnStarts += 1),
    onTurnEnd: () => void (rec.turnEnds += 1),
    onMetrics: (turnId, marks, derived) => void rec.metrics.push({ turnId, marks, derived }),
    onUsage: (turnId, legs) => void rec.usage.push({ turnId, legs }),
    onLog() {}, onError: (e) => void rec.errors.push(e.message),
  };
  const config = { mode: 'realtime', realtimeModelId: 'mock-s2s', systemPrompt: '', turnDetection: 'server_vad' } as StartConfig;
  const session = new MockRealtimeProvider().createSession({ sessionId: 'r', config, events, credentials: {} });
  await session.start();

  session.pushAudio(loud(2.5));   // billable input
  session.sendText('hello');      // starts speaking
  await sleep(400);
  session.interrupt();            // barge-in part-way through the answer

  check('the barged-in turn is billed', rec.usage.length, 1);
  const rt = rec.usage[0].legs[0];
  check('input audio is on the record', rt.inputUnits, 2.5);
  ok('so is the audio it managed to speak', rt.outputUnits > 0);
  check('turn_start and turn_end stay balanced', rec.turnStarts, rec.turnEnds);

  // And again for close(), which is what ending a conversation does.
  session.pushAudio(loud(1));
  session.sendText('again');
  await sleep(400);
  await session.close();
  check('ending mid-answer bills that turn too', rec.usage.length, 2);
  ok('billed exactly once each', rec.usage[1].legs.length === 1);
}

console.log(`\n${'-'.repeat(60)}`);
if (failures.length) {
  console.log(`${failures.length} FAILED, ${passed} passed\n`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`ALL ${passed} CHECKS PASSED`);
