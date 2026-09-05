/**
 * Vendor round-trip check — TTS synthesises a sentence, the PCM is streamed back
 * into STT at real time, and you get the transcript plus both latency numbers.
 * Exercises the shipped provider classes, so it validates auth, the WebSocket
 * protocol, audio format and resampling in one shot. No microphone involved.
 *
 *   npx tsx scripts/roundtrip.ts ["text to say"] [language]
 *
 *   TTS=cartesia-tts TTS_MODEL=sonic-3.6 STT=cartesia-stt STT_MODEL=ink-2 \
 *     npx tsx scripts/roundtrip.ts
 *
 * Legs can be mixed across vendors — Sonic in, Saaras out — which is the point.
 */
import 'dotenv/config';
import { getStt, getTts } from '../src/providers/factory.js';
import { findProvider, voicesFor } from '../src/providers/catalog.js';
import { CANONICAL_SAMPLE_RATE } from '../src/shared/protocol.js';
import { pcm16DurationMs } from '../src/audio/pcm.js';

const TEXT = process.argv[2] ?? 'Our refund window is thirty days from the date of purchase.';
const LANGUAGE = process.argv[3] ?? process.env.LANG_CODE ?? 'en';

const TTS_ID = process.env.TTS ?? 'cartesia-tts';
const STT_ID = process.env.STT ?? 'cartesia-stt';
const TTS_MODEL = process.env.TTS_MODEL ?? findProvider(TTS_ID)?.models[0]?.id ?? '';
const STT_MODEL = process.env.STT_MODEL ?? findProvider(STT_ID)?.models[0]?.id ?? '';
const VOICE = process.env.VOICE ?? voicesFor(TTS_ID, TTS_MODEL)[0]?.id;
const TTS_LANG = process.env.TTS_LANG ?? LANGUAGE;
const STT_LANG = process.env.STT_LANG ?? LANGUAGE;

const credentials = { ...process.env };
const ms = (n: number) => `${Math.round(n)}ms`;

const tts = getTts(TTS_ID);
const stt = getStt(STT_ID);
if (!tts) throw new Error(`TTS provider "${TTS_ID}" is not registered`);
if (!stt) throw new Error(`STT provider "${STT_ID}" is not registered`);

for (const id of [TTS_ID, STT_ID]) {
  const missing = (findProvider(id)?.envKeys ?? []).filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`${id} needs ${missing.join(', ')} in backend/.env`);
    process.exit(1);
  }
}

/* ------------------------------- synthesise ------------------------------- */

async function synthesize(): Promise<Buffer> {
  console.log(`\n[TTS] ${TTS_ID} · ${TTS_MODEL} · voice=${VOICE ?? '(default)'} · ${TTS_LANG}`);
  console.log(`[TTS] text: "${TEXT}"`);

  const chunks: Buffer[] = [];
  let firstAt: number | undefined;

  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const t0 = performance.now();
  const stream = await tts!.open(
    { model: TTS_MODEL, voice: VOICE, language: TTS_LANG, sampleRate: CANONICAL_SAMPLE_RATE, credentials },
    {
      onAudio: (chunk) => {
        if (firstAt === undefined) {
          firstAt = performance.now() - t0;
          console.log(`[TTS] first audio after ${ms(firstAt)}  <- time-to-first-byte`);
        }
        chunks.push(chunk);
      },
      onDone: () => resolveDone(),
      onError: (err) => rejectDone(err),
    },
  );

  // Feed word by word, the way the LLM streams it.
  for (const word of TEXT.split(' ')) stream.pushText(`${word} `);
  stream.flush();

  const timeout = setTimeout(() => rejectDone(new Error('TTS timed out after 40s')), 40_000);
  await done;
  clearTimeout(timeout);
  stream.close();

  const audio = Buffer.concat(chunks);
  console.log(
    `[TTS] ${chunks.length} chunks · ${audio.length} bytes · ` +
      `${(pcm16DurationMs(audio.length) / 1000).toFixed(2)}s audio · total ${ms(performance.now() - t0)}`,
  );
  if (audio.length === 0) throw new Error(`${TTS_ID} returned no audio`);
  return audio;
}

/* -------------------------------- transcribe ------------------------------ */

async function transcribe(audio: Buffer): Promise<string> {
  console.log(`\n[STT] ${STT_ID} · ${STT_MODEL} · ${STT_LANG}`);

  let resolveFinal!: (t: string) => void;
  const gotFinal = new Promise<string>((res) => (resolveFinal = res));

  const t0 = performance.now();
  let firstAt: number | undefined;
  let lastPartial = '';

  const stream = await stt!.open(
    { model: STT_MODEL, language: STT_LANG, sampleRate: CANONICAL_SAMPLE_RATE, credentials, vad: true },
    {
      onPartial: (text) => {
        if (firstAt === undefined) {
          firstAt = performance.now() - t0;
          console.log(`[STT] first partial after ${ms(firstAt)}`);
        }
        if (text !== lastPartial) {
          lastPartial = text;
          console.log(`[STT] partial: ${text}`);
        }
      },
      onFinal: (text) => {
        console.log(`[STT] FINAL after ${ms(performance.now() - t0)}: ${text}`);
        resolveFinal(text);
      },
      onSpeechEnd: () => console.log(`[STT] speech end detected at ${ms(performance.now() - t0)}  <- latency t0`),
      onError: (err) => console.error(`[STT] error: ${err.message}`),
    },
  );

  // ~100ms frames at real time, so vendor endpointing behaves as it would live.
  const frameBytes = (100 * CANONICAL_SAMPLE_RATE * 2) / 1000;
  for (let off = 0; off < audio.length; off += frameBytes) {
    stream.pushAudio(audio.subarray(off, Math.min(audio.length, off + frameBytes)));
    await new Promise((r) => setTimeout(r, 100));
  }
  // Trailing silence lets the endpointer close the utterance.
  const silence = Buffer.alloc(frameBytes);
  for (let i = 0; i < 15; i++) {
    stream.pushAudio(silence);
    await new Promise((r) => setTimeout(r, 100));
  }

  const result = await Promise.race([
    gotFinal,
    new Promise<string>((r) => setTimeout(() => r(''), 12_000)),
  ]);
  stream.close();
  return result;
}

const audio = await synthesize();
const heard = await transcribe(audio);

console.log('\n--- round trip ---');
console.log(`said:  ${TEXT}`);
console.log(`heard: ${heard || '(nothing)'}`);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-෿ ]/g, '').split(/\s+/).filter(Boolean);
const said = norm(TEXT);
const got = norm(heard);
const overlap = got.filter((w) => said.includes(w)).length;
const score = said.length ? overlap / said.length : 0;
console.log(`word overlap: ${overlap}/${said.length} (${Math.round(score * 100)}%)`);

if (!heard) {
  console.log('\nFAIL — no transcript');
  process.exit(1);
}
console.log(`\nPASS — ${TTS_ID} -> ${STT_ID} round trip works.`);
process.exit(0);
