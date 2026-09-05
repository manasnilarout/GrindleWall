/**
 * Re-measures ElevenLabs' two text-buffering knobs — `chunk_length_schedule`
 * and `auto_mode` — the way this repo measured Cartesia's and Murf's.
 *
 *   npm run elevenlabs:buffer          (needs ELEVENLABS_API_KEY; BILLABLE)
 *
 * This is the probe behind `CHUNK_LENGTH_SCHEDULE` and `AUTO_MODE` in
 * `ElevenLabsTtsProvider.ts`. Those constants pick an audio-quality tradeoff,
 * and the file makes a NEGATIVE claim about one of them ("auto_mode is the
 * Cartesia fault on this vendor"), which under this repo's claim-discipline
 * rule may not ship without something committed that can reproduce it.
 *
 * The method, and why it is not a TTFB test. Cartesia's equivalent knob at 0
 * voiced every token as its own utterance: 2.6x the audio, mangled prosody, and
 * a TTFB that looked BETTER for it. So the measurement is RENDERED AUDIO
 * DURATION against a one-shot reference of the same text. TTFB is reported
 * alongside because it is what you would otherwise be tempted to optimise, and
 * the point is that the two disagree.
 *
 * What it cannot see: rendered duration catches word-isolation, the gross
 * fault. Subtler prosody damage needs ears, and nobody has done that comparison.
 * Treat a duration within a few percent of the reference as "not obviously
 * broken", not as "identical quality".
 */
import 'dotenv/config';
import WebSocket from 'ws';

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('ELEVENLABS_API_KEY is not set in backend/.env');
  process.exit(1);
}

const MODEL = process.env.TTS_MODEL ?? 'eleven_flash_v2_5';
const VOICE = process.env.VOICE ?? 'JBFqnCBsd6RMkjVDRZzb';
const SAMPLE_RATE = 24000;
/** Long enough to cross several schedule steps; short enough to stay cheap. */
const TEXT =
  process.argv[2] ??
  'Our refund window is thirty days from the date of purchase, and refunds are issued to the ' +
    'original payment method within five business days.';
/** Roughly a fast LLM's token cadence, which is the condition that matters. */
const PER_WORD_MS = Number(process.env.PER_WORD_MS ?? 40);
const TRIALS = Number(process.env.TRIALS ?? 3);

interface Run {
  ttfb: number;
  seconds: number;
  error?: string;
}

function synthesise(schedule: number[] | undefined, autoMode: boolean, perWordMs: number): Promise<Run> {
  return new Promise((resolve) => {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream-input` +
      `?model_id=${MODEL}&output_format=pcm_${SAMPLE_RATE}&auto_mode=${autoMode}`;
    const ws = new WebSocket(url, { headers: { 'xi-api-key': KEY as string } });
    const t0 = Date.now();
    let ttfb = -1;
    let bytes = 0;
    let error: string | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve({ ttfb, seconds: bytes / 2 / SAMPLE_RATE, error });
    };

    ws.on('open', async () => {
      const init: Record<string, unknown> = {
        text: ' ',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      };
      // Omitted entirely for the auto_mode run: the vendor documents auto_mode
      // as disabling the schedule, and sending both invites it to pick one.
      if (schedule) init.generation_config = { chunk_length_schedule: schedule };
      ws.send(JSON.stringify(init));
      for (const word of TEXT.split(' ')) {
        ws.send(JSON.stringify({ text: `${word} ` }));
        if (perWordMs) await new Promise((r) => setTimeout(r, perWordMs));
      }
      ws.send(JSON.stringify({ text: '' })); // end of stream: flush the tail
    });

    ws.on('message', (raw) => {
      let msg: { audio?: string; isFinal?: boolean; error?: unknown; message?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.audio) {
        if (ttfb < 0) ttfb = Date.now() - t0;
        bytes += Buffer.from(msg.audio, 'base64').length;
      }
      if (msg.error ?? msg.message) error = String(msg.error ?? msg.message).slice(0, 70);
      if (msg.isFinal) finish();
    });

    ws.on('close', finish);
    ws.on('error', (err) => {
      error = err.message.slice(0, 70);
      finish();
    });
    setTimeout(finish, 40_000);
  });
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`\n${MODEL} · voice ${VOICE} · ${TEXT.length} characters · ${TRIALS} trials each`);

/* The reference: the same text handed over in one piece, so the vendor never
 * has to guess where an utterance ends. Everything else is compared to this. */
const refs: number[] = [];
for (let i = 0; i < TRIALS; i++) {
  const r = await synthesise([120, 160, 250, 290], false, 0);
  if (r.error) console.log(`  reference trial ${i + 1} errored: ${r.error}`);
  if (r.seconds > 0) refs.push(r.seconds);
  await new Promise((r) => setTimeout(r, 700));
}
if (refs.length === 0) {
  console.error('\nThe one-shot reference produced no audio — nothing can be compared. Aborting.');
  process.exit(1);
}
const reference = median(refs);
console.log(
  `\none-shot reference: ${reference.toFixed(2)}s rendered ` +
    `(trials: ${refs.map((r) => r.toFixed(2)).join(', ')})\n`,
);
console.log(`streamed word by word at ~${PER_WORD_MS}ms/word:\n`);

const CASES: Array<{ label: string; schedule?: number[]; autoMode: boolean }> = [
  { label: '[120,160,250,290] vendor default', schedule: [120, 160, 250, 290], autoMode: false },
  { label: '[50,160,250,290] SHIPPED', schedule: [50, 160, 250, 290], autoMode: false },
  { label: '[50,120,160,250]', schedule: [50, 120, 160, 250], autoMode: false },
  { label: '[20,50,120,160] below the floor', schedule: [20, 50, 120, 160], autoMode: false },
  { label: 'auto_mode = true', autoMode: true },
];

let worst = 0;
for (const c of CASES) {
  const ttfbs: number[] = [];
  const durations: number[] = [];
  let error: string | undefined;
  for (let i = 0; i < TRIALS; i++) {
    const r = await synthesise(c.schedule, c.autoMode, PER_WORD_MS);
    error ??= r.error;
    if (r.ttfb >= 0) ttfbs.push(r.ttfb);
    if (r.seconds > 0) durations.push(r.seconds);
    await new Promise((r) => setTimeout(r, 700));
  }
  if (durations.length === 0) {
    console.log(`  ${c.label.padEnd(34)} REFUSED${error ? ` — ${error}` : ''}`);
    continue;
  }
  const pct = (median(durations) / reference) * 100;
  worst = Math.max(worst, pct);
  console.log(
    `  ${c.label.padEnd(34)} TTFB ${String(median(ttfbs)).padStart(5)}ms   ` +
      `rendered ${median(durations).toFixed(2)}s = ${pct.toFixed(0)}% of reference` +
      `${error ? `  (${error})` : ''}`,
  );
}

console.log(
  '\nRead the RENDERED column, not TTFB. A setting materially above 100% is ' +
    'voicing fragments as separate utterances — the Cartesia fault, which cost ' +
    '260% there. Anything within a few percent is not obviously broken; it is ' +
    'not a guarantee of equal prosody, which needs ears.',
);
process.exit(worst > 130 ? 1 : 0);
