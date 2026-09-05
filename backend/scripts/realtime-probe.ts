/**
 * Realtime speech-in probe — synthesises a spoken question with a working TTS,
 * streams the PCM into a realtime provider at real time, and prints the reply
 * plus the usage row the vendor reported.
 *
 *   npx tsx scripts/realtime-probe.ts ["text to say"]
 *
 *   REALTIME=openai-realtime REALTIME_MODEL=gpt-realtime-2.1-mini \
 *   TTS=elevenlabs-tts TTS_MODEL=eleven_flash_v2_5 \
 *     npx tsx scripts/realtime-probe.ts
 *
 * `smoke.mjs realtime` sends a TEXT turn, so it never bills an audio input
 * token. This is the only check that exercises the audio-in half of a
 * speech-to-speech turn — and therefore the only one that can tell whether
 * `audioInputTokens` is really being reported and priced at the audio rate.
 */
import 'dotenv/config';
import { getRealtime, getTts } from '../src/providers/factory.js';
import { findProvider, voicesFor } from '../src/providers/catalog.js';
import { CANONICAL_SAMPLE_RATE } from '../src/shared/protocol.js';
import { pcm16DurationMs } from '../src/audio/pcm.js';
import { priceLeg } from '../src/pricing/rates.js';
import type { LegUsage, MetricMark } from '../src/shared/protocol.js';
import type { SessionEvents } from '../src/providers/types.js';

const TEXT = process.argv[2] ?? 'How fast are you? Answer in one short sentence.';

const RT_ID = process.env.REALTIME ?? 'openai-realtime';
const RT_MODEL = process.env.REALTIME_MODEL ?? findProvider(RT_ID)?.models[0]?.id ?? '';
const TTS_ID = process.env.TTS ?? 'elevenlabs-tts';
const TTS_MODEL = process.env.TTS_MODEL ?? findProvider(TTS_ID)?.models[0]?.id ?? '';
const VOICE = process.env.VOICE ?? voicesFor(TTS_ID, TTS_MODEL)[0]?.id;
const RT_VOICE = process.env.RT_VOICE ?? voicesFor(RT_ID, RT_MODEL)[0]?.id;
const LANGUAGE = process.env.LANG_CODE ?? 'en';

const credentials = { ...process.env };
const ms = (n: number) => `${Math.round(n)}ms`;

for (const id of [RT_ID, TTS_ID]) {
  const missing = (findProvider(id)?.envKeys ?? []).filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`${id} needs ${missing.join(', ')} in backend/.env`);
    process.exit(1);
  }
}

/* ------------------------------- synthesise ------------------------------- */

async function synthesize(): Promise<Buffer> {
  const tts = getTts(TTS_ID);
  if (!tts) throw new Error(`TTS provider "${TTS_ID}" is not registered`);
  console.log(`\n[TTS] ${TTS_ID} · ${TTS_MODEL} · voice=${VOICE ?? '(default)'}`);
  console.log(`[TTS] text: "${TEXT}"`);

  const chunks: Buffer[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const stream = await tts.open(
    { model: TTS_MODEL, voice: VOICE, language: LANGUAGE, sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    { onAudio: (c) => chunks.push(c), onDone: () => resolveDone(), onError: (e) => rejectDone(e) },
  );
  for (const word of TEXT.split(' ')) stream.pushText(`${word} `);
  stream.flush();

  const timeout = setTimeout(() => rejectDone(new Error('TTS timed out after 40s')), 40_000);
  await done;
  clearTimeout(timeout);
  stream.close();

  const audio = Buffer.concat(chunks);
  console.log(`[TTS] ${audio.length} bytes · ${(pcm16DurationMs(audio.length) / 1000).toFixed(2)}s audio`);
  if (audio.length === 0) throw new Error(`${TTS_ID} returned no audio`);
  return audio;
}

/* -------------------------------- converse -------------------------------- */

async function converse(audio: Buffer): Promise<void> {
  const realtime = getRealtime(RT_ID);
  if (!realtime) throw new Error(`Realtime provider "${RT_ID}" is not registered`);
  console.log(`\n[RT] ${RT_ID} · ${RT_MODEL} · voice=${RT_VOICE ?? '(default)'}`);

  let assistant = '';
  let user = '';
  let audioBytes = 0;
  let firstAudioAt: number | undefined;
  let usage: LegUsage[] | undefined;
  let marks: MetricMark[] = [];
  let t0 = performance.now();

  let resolveUsage!: () => void;
  const gotUsage = new Promise<void>((res) => (resolveUsage = res));

  const events: SessionEvents = {
    onUserTranscript: (text, final) => {
      if (final) {
        user = text;
        console.log(`[RT] user final: ${text}`);
      }
    },
    onAssistantTranscript: (text, final) => {
      if (final) assistant = text;
    },
    onAudio: (chunk) => {
      if (firstAudioAt === undefined) {
        firstAudioAt = performance.now() - t0;
        console.log(`[RT] first audio after ${ms(firstAudioAt)}  <- from commit`);
      }
      audioBytes += chunk.length;
    },
    onTurnStart: () => {},
    onTurnEnd: () => {},
    onMetrics: (_id, m) => (marks = m),
    onUsage: (_id, legs) => {
      usage = legs;
      resolveUsage();
    },
    onLog: (level, message) => {
      if (level !== 'info') console.log(`[RT] ${level}: ${message}`);
    },
    onError: (err) => console.error(`[RT] error: ${err.message}`),
  };

  const session = realtime.createSession({
    sessionId: 'realtime-probe',
    config: {
      mode: 'realtime',
      realtimeProviderId: RT_ID,
      realtimeModelId: RT_MODEL,
      systemPrompt: 'You are a terse voice assistant. Answer in one short sentence.',
      voice: RT_VOICE,
      language: LANGUAGE,
      turnDetection: 'manual',
    },
    events,
    credentials,
  });

  await session.start();

  // ~100ms frames at real time, so the vendor meters the audio as it would live.
  const frameBytes = (100 * CANONICAL_SAMPLE_RATE * 2) / 1000;
  for (let off = 0; off < audio.length; off += frameBytes) {
    session.pushAudio(audio.subarray(off, Math.min(audio.length, off + frameBytes)));
    await new Promise((r) => setTimeout(r, 100));
  }
  t0 = performance.now();
  session.commitAudio();

  await Promise.race([gotUsage, new Promise<void>((r) => setTimeout(r, 45_000))]);
  await session.close();

  console.log(`\n[RT] assistant: ${assistant || '(no transcript)'}`);
  console.log(`[RT] audio out: ${audioBytes} bytes (${(pcm16DurationMs(audioBytes) / 1000).toFixed(2)}s)`);
  if (marks.length) console.log(`[RT] marks: ${marks.map((m) => `${m.name}@${Math.round(m.atMs)}ms`).join(' ')}`);

  console.log('\n--- usage as the vendor reported it ---');
  if (!usage?.length) {
    console.log('FAIL — no usage row');
    process.exit(1);
  }
  const problems: string[] = [];
  for (const leg of usage) {
    console.log(JSON.stringify(leg, null, 2));
    const priced = priceLeg(leg);
    console.log(`priced: ${priced.cost ? `USD ${priced.cost.amountUsd}` : `UNPRICED (${priced.unpricedReason})`}`);

    if (leg.source !== 'vendor') problems.push('usage is not vendor-reported');
    if (!leg.audioInputTokens) problems.push('audioInputTokens is 0 — audio input was not billed as audio');
    if (!leg.audioOutputTokens) problems.push('audioOutputTokens is 0 — audio output was not billed as audio');
    if ((leg.audioInputTokens ?? 0) > leg.inputUnits) problems.push('audioInputTokens exceeds inputUnits');
    if ((leg.audioOutputTokens ?? 0) > leg.outputUnits) problems.push('audioOutputTokens exceeds outputUnits');
    if (!priced.cost) problems.push('leg did not price');
  }
  if (!user) problems.push('no user transcript — the vendor never transcribed the audio');
  if (audioBytes === 0) problems.push('no audio came back');

  if (problems.length) {
    console.log(`\nFAIL — ${problems.join('; ')}`);
    process.exit(1);
  }
  console.log(`\nPASS — ${RT_ID} heard speech, answered, and billed audio tokens as audio.`);
  process.exit(0);
}

await converse(await synthesize());
