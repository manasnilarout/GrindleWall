/**
 * The live Nova Sonic probe. NEEDS REAL AWS CREDENTIALS and bills real money
 * (a few seconds of speech per case, so cents).
 *
 *   npm run nova:probe
 *   NOVA_PROBE_REGION=us-east-1 npm run nova:probe
 *
 * WHY THIS EXISTS
 *
 * `npm run nova:selftest` drives NovaSonicProvider against a fake written from
 * the same doc pages as the provider itself. The two agree by construction and
 * would agree just as happily if both were wrong — which is exactly how this
 * repo shipped 27 green Murf checks for weeks against a provider that had never
 * connected. Nothing about what AWS accepts can come from there.
 *
 * So this script asks AWS directly, and every question below is one where the
 * documentation is either silent, self-contradictory, or contradicted by the
 * SDK. Each is phrased so the answer is a fact rather than an impression, and
 * the vendor's own error text is printed verbatim rather than paraphrased.
 *
 *   A. Does `amazon.nova-2-sonic-v1:0` accept a session at all?
 *      The API reference AND the SDK's own JSDoc both say "Currently, only
 *      `amazon.nova-sonic-v1:0` is supported". The Nova 2 model card, the user
 *      guide and the aws-samples client all pass the v2 id to the same
 *      operation. They cannot both be right.
 *
 *   B. Is `amazon.nova-sonic-v1:0` really gone? Its model card gives an EOL of
 *      2026-09-14. If it still answers, the catalog comment saying it is EOL is
 *      wrong and must be corrected — an EOL date is a claim like any other.
 *
 *   C. Does input audio at 24000 Hz work? The enum documents 8000|16000|24000,
 *      but every AWS sample uses 16000, so 16000 is what the provider sends.
 *      If 24000 is accepted, the provider can stop resampling mic audio
 *      entirely — CANONICAL_SAMPLE_RATE is 24000 — and one conversion leaves
 *      the hot path.
 *
 *   D. Are voice ids case-sensitive? A third-party blog says `"Tiffany"` is
 *      rejected; AWS does not say either way. This repo has been burned once by
 *      assuming a vendor's id spelling (Murf's "Namrita"), so this is asked
 *      rather than assumed — and asked THREE TIMES, because it is a negative
 *      claim and vendors have transient failures.
 *
 *   E. Does `usageEvent.totalInputTokens` equal speechTokens + textTokens?
 *      This repo's containment rule says a total includes its breakdown, and
 *      `priceLeg` subtracts on that basis. AWS documents both numbers and never
 *      says how they relate. The provider sums the halves itself rather than
 *      trust the flat total; this prints both so that choice is checkable.
 *
 * WHAT IT DOES NOT DO: measure latency. `REALTIME=aws-nova-sonic npm run
 * realtime:probe` already drives a full turn with real speech and asserts the
 * vendor bills audio tokens as audio. Run that too — it is the other half.
 *
 * AS OF 2026-09-17 THIS SCRIPT HAS NEVER BEEN RUN. There are no AWS credentials
 * in this repo. Every Nova Sonic claim in README.md, catalog.ts and the
 * provider header is therefore doc-derived, and says so.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamInput,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { getTts } from '../src/providers/factory.js';
import { findProvider, voicesFor } from '../src/providers/catalog.js';
import { CANONICAL_SAMPLE_RATE } from '../src/shared/protocol.js';
import { pcm16DurationMs, resamplePcm16 } from '../src/audio/pcm.js';

const REGION = process.env.NOVA_PROBE_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
const NOVA2 = 'amazon.nova-2-sonic-v1:0';
const NOVA1 = 'amazon.nova-sonic-v1:0';
const SPOKEN = 'What is your refund window? Answer in one short sentence.';

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  console.error('nova:probe needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in backend/.env');
  console.error('This is the only check that can say what AWS accepts; without a key there is nothing to run.');
  process.exit(1);
}

/* ------------------------------ one session ------------------------------ */

interface ProbeResult {
  accepted: boolean;
  /** The vendor's own words, never a paraphrase. */
  error?: string;
  errorKind?: string;
  events: Array<Record<string, any>>;
  firstAudioMs?: number;
  audioBytes: number;
}

interface ProbeOpts {
  modelId: string;
  voiceId: string;
  inputRate: number;
  audio: Buffer;
  /** How long to wait for the model to finish answering. */
  waitMs?: number;
}

/**
 * Opens one real Bedrock stream, streams the audio at real time, and collects
 * everything that comes back.
 *
 * Deliberately NOT built on NovaSonicProvider: the provider is the thing under
 * test, and a probe that shared its event builders could not tell a wrong field
 * name from a right one — they would be wrong together. This constructs the
 * events inline so the wire shape being asked about is visible in this file.
 */
async function probe(opts: ProbeOpts): Promise<ProbeResult> {
  const client = new BedrockRuntimeClient({
    region: REGION,
    credentials: {
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    },
    requestHandler: new NodeHttp2Handler({ requestTimeout: 120_000, sessionTimeout: 120_000 }),
  });

  const promptName = randomUUID();
  const sysContent = randomUUID();
  const audioContent = randomUUID();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let queueClosed = false;
  const send = (event: unknown) => {
    queue.push(event);
    const w = wake;
    wake = undefined;
    w?.();
  };
  const closeQueue = () => {
    queueClosed = true;
    const w = wake;
    wake = undefined;
    w?.();
  };

  async function* body(): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
    for (;;) {
      if (queue.length === 0) {
        if (queueClosed) return;
        await new Promise<void>((r) => (wake = r));
        continue;
      }
      yield { chunk: { bytes: encoder.encode(JSON.stringify(queue.shift())) } };
    }
  }

  send({
    event: {
      sessionStart: {
        inferenceConfiguration: { maxTokens: 512, topP: 0.9, temperature: 0.7 },
        ...(opts.modelId === NOVA2 ? { turnDetectionConfiguration: { endpointingSensitivity: 'HIGH' } } : {}),
      },
    },
  });
  send({
    event: {
      promptStart: {
        promptName,
        textOutputConfiguration: { mediaType: 'text/plain' },
        audioOutputConfiguration: {
          mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16,
          channelCount: 1, voiceId: opts.voiceId, encoding: 'base64', audioType: 'SPEECH',
        },
        toolUseOutputConfiguration: { mediaType: 'application/json' },
      },
    },
  });
  send({
    event: {
      contentStart: {
        promptName, contentName: sysContent, type: 'TEXT', interactive: false, role: 'SYSTEM',
        textInputConfiguration: { mediaType: 'text/plain' },
      },
    },
  });
  send({ event: { textInput: { promptName, contentName: sysContent, content: 'You are terse. Answer in one short sentence.' } } });
  send({ event: { contentEnd: { promptName, contentName: sysContent } } });
  send({
    event: {
      contentStart: {
        promptName, contentName: audioContent, type: 'AUDIO', interactive: true, role: 'USER',
        audioInputConfiguration: {
          mediaType: 'audio/lpcm', sampleRateHertz: opts.inputRate, sampleSizeBits: 16,
          channelCount: 1, audioType: 'SPEECH', encoding: 'base64',
        },
      },
    },
  });

  const result: ProbeResult = { accepted: false, events: [], audioBytes: 0 };
  let t0 = performance.now();

  try {
    const response = await client.send(
      new InvokeModelWithBidirectionalStreamCommand({ modelId: opts.modelId, body: body() }),
    );

    const reader = (async () => {
      for await (const out of response.body!) {
        // Deferred errors: these do NOT throw, they arrive as union members.
        const failure =
          out.validationException ?? out.throttlingException ?? out.modelTimeoutException ??
          out.modelStreamErrorException ?? out.serviceUnavailableException ?? out.internalServerException;
        if (failure) {
          result.errorKind = Object.keys(out).find((k) => k !== 'chunk');
          result.error = failure.message ?? '(no message)';
          return;
        }
        if (!out.chunk?.bytes) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(decoder.decode(out.chunk.bytes));
        } catch {
          continue;
        }
        if (!parsed?.event) continue;
        result.events.push(parsed.event);
        result.accepted = true;
        if (parsed.event.audioOutput?.content) {
          const bytes = Buffer.from(parsed.event.audioOutput.content, 'base64').length;
          if (result.audioBytes === 0) result.firstAudioMs = performance.now() - t0;
          result.audioBytes += bytes;
        }
      }
    })();

    // Stream the audio in at real time, ~60ms a frame, so the vendor's
    // endpointing sees a natural microphone cadence rather than a dump.
    const pcm = resamplePcm16(opts.audio, CANONICAL_SAMPLE_RATE, opts.inputRate);
    const frameBytes = Math.floor((60 * opts.inputRate * 2) / 1000);
    for (let off = 0; off < pcm.length && !result.error; off += frameBytes) {
      send({
        event: {
          audioInput: {
            promptName, contentName: audioContent,
            content: pcm.subarray(off, Math.min(pcm.length, off + frameBytes)).toString('base64'),
          },
        },
      });
      await new Promise((r) => setTimeout(r, 60));
    }
    t0 = performance.now(); // speech is over: everything after this is the answer

    await Promise.race([reader, new Promise((r) => setTimeout(r, opts.waitMs ?? 20_000))]);

    send({ event: { contentEnd: { promptName, contentName: audioContent } } });
    send({ event: { promptEnd: { promptName } } });
    send({ event: { sessionEnd: {} } });
    closeQueue();
    await Promise.race([reader, new Promise((r) => setTimeout(r, 3_000))]);
  } catch (err) {
    // A thrown error here is the connection or signing layer, not the model.
    result.error = err instanceof Error ? err.message : String(err);
    result.errorKind = 'thrown';
    closeQueue();
  } finally {
    client.destroy();
  }
  return result;
}

/* ------------------------------ real speech ------------------------------ */

/**
 * Nova endpoints on real speech, so a sine tone will not produce a turn. The
 * question is synthesised with whichever TTS leg has a key, exactly as
 * `realtime-probe.ts` does.
 */
async function synthesize(): Promise<Buffer> {
  const ttsId = process.env.TTS ?? 'elevenlabs-tts';
  const ttsModel = process.env.TTS_MODEL ?? findProvider(ttsId)?.models[0]?.id ?? '';
  const missing = (findProvider(ttsId)?.envKeys ?? []).filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `nova:probe needs a working TTS leg to speak with. ${ttsId} needs ${missing.join(', ')}. ` +
        'Set TTS= and TTS_MODEL= to a provider you have a key for.',
    );
  }
  const tts = getTts(ttsId);
  if (!tts) throw new Error(`TTS provider "${ttsId}" is not registered`);

  const chunks: Buffer[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
  const stream = await tts.open(
    {
      model: ttsModel,
      voice: process.env.VOICE ?? voicesFor(ttsId, ttsModel)[0]?.id,
      language: 'en',
      sampleRate: CANONICAL_SAMPLE_RATE,
      credentials: { ...process.env },
    },
    { onAudio: (c) => chunks.push(c), onDone: () => resolveDone(), onError: (e) => rejectDone(e) },
  );
  stream.pushText(SPOKEN);
  stream.flush();
  const timer = setTimeout(() => rejectDone(new Error('TTS timed out after 40s')), 40_000);
  await done;
  clearTimeout(timer);
  stream.close();

  const audio = Buffer.concat(chunks);
  console.log(`[tts] ${ttsId}:${ttsModel} produced ${(pcm16DurationMs(audio.length) / 1000).toFixed(2)}s of speech`);
  if (audio.length === 0) throw new Error(`${ttsId} returned no audio`);
  return audio;
}

/* -------------------------------- findings -------------------------------- */

const findings: Array<{ q: string; answer: string; evidence: string }> = [];
const record = (q: string, answer: string, evidence: string) => {
  findings.push({ q, answer, evidence });
  console.log(`\n  ${q}\n  -> ${answer}\n     ${evidence}`);
};

const verdict = (r: ProbeResult) =>
  r.error ? `REJECTED (${r.errorKind}): ${r.error}` : r.accepted ? 'ACCEPTED' : 'no response before the timeout';

const audio = await synthesize();
console.log(`\nregion: ${REGION}\n`);

/* --- A. does the Nova 2 id work, against both docs that say it does not? --- */
console.log('A. model id amazon.nova-2-sonic-v1:0');
const a = await probe({ modelId: NOVA2, voiceId: 'tiffany', inputRate: 16000, audio });
record(
  'Does amazon.nova-2-sonic-v1:0 accept a bidirectional session?',
  verdict(a),
  a.error
    ? 'The API reference and SDK JSDoc ("Currently, only amazon.nova-sonic-v1:0 is supported") appear to be RIGHT, and the Nova 2 user guide wrong. Do not ship the v2 id.'
    : `Accepted; ${a.events.length} events, ${a.audioBytes} bytes of audio back. The API reference and SDK JSDoc are stale.`,
);
if (a.firstAudioMs !== undefined) {
  record(
    'Time from end of streamed speech to first audio byte',
    `${Math.round(a.firstAudioMs)}ms`,
    'Includes Nova\'s own endpointing pause at endpointingSensitivity HIGH (documented 1.5s), so it is NOT comparable with a pipeline rig\'s TTFA without subtracting it.',
  );
}

/* --- B. is v1 actually EOL? --- */
console.log('\nB. legacy model id amazon.nova-sonic-v1:0 (model card EOL 2026-09-14)');
const b = await probe({ modelId: NOVA1, voiceId: 'tiffany', inputRate: 16000, audio, waitMs: 12_000 });
record(
  'Is the v1 model still served after its published EOL?',
  verdict(b),
  b.error
    ? 'Consistent with the published EOL. The catalog offering only Nova 2 is correct.'
    : 'STILL SERVED despite the model card\'s EOL date. The catalog comment claiming it is EOL must be corrected to say it still answers.',
);

/* --- C. 24 kHz input: would remove a resample from the hot path --- */
console.log('\nC. input audio at 24000 Hz (the enum lists it; every AWS sample uses 16000)');
const c = await probe({ modelId: NOVA2, voiceId: 'tiffany', inputRate: 24000, audio });
record(
  'Does audioInputConfiguration.sampleRateHertz = 24000 work?',
  verdict(c),
  c.error
    ? 'Keep NOVA_INPUT_RATE at 16000. The enum lists 24000 but the service refuses it.'
    : 'Accepted. NOVA_INPUT_RATE can become 24000, which is CANONICAL_SAMPLE_RATE — the inbound resample then disappears entirely.',
);

/* --- D. voice id case sensitivity: a NEGATIVE claim, so run it three times --- */
console.log('\nD. capitalised voice id "Tiffany", three times (negative claims need repetition)');
const d: ProbeResult[] = [];
for (let i = 0; i < 3; i++) {
  d.push(await probe({ modelId: NOVA2, voiceId: 'Tiffany', inputRate: 16000, audio, waitMs: 12_000 }));
  console.log(`   run ${i + 1}: ${verdict(d[i])}`);
}
const allRejected = d.every((r) => !!r.error);
const allAccepted = d.every((r) => !r.error && r.accepted);
record(
  'Are voice ids case-sensitive?',
  allRejected ? 'YES — "Tiffany" rejected on all 3 runs' : allAccepted ? 'NO — "Tiffany" accepted on all 3 runs' : 'INCONSISTENT across 3 runs',
  allRejected
    ? `Verbatim: "${d[0].error}". The catalog storing lowercase ids is load-bearing, not cosmetic.`
    : allAccepted
      ? 'The third-party claim that capitalised ids are rejected does not reproduce. Do not repeat it.'
      : `Cannot reproduce a consistent answer: ${d.map((r, i) => `run${i + 1}=${r.error ? 'rejected' : 'accepted'}`).join(', ')}. Report as "cannot reproduce" rather than picking one.`,
);

/* --- E. does the flat total include the speech/text breakdown? --- */
console.log('\nE. usageEvent containment');
const usageEvents = a.events.map((e) => e.usageEvent).filter(Boolean);
if (usageEvents.length === 0) {
  record(
    'Does totalInputTokens equal speechTokens + textTokens?',
    'UNANSWERED — no usageEvent arrived',
    'Without a usage event there is nothing to compare. The provider sums the halves itself, which cannot contradict its own breakdown, so this stays an open question.',
  );
} else {
  const last = usageEvents.at(-1);
  const tIn = last.details?.total?.input ?? {};
  const tOut = last.details?.total?.output ?? {};
  const sumIn = (tIn.speechTokens ?? 0) + (tIn.textTokens ?? 0);
  const sumOut = (tOut.speechTokens ?? 0) + (tOut.textTokens ?? 0);
  const inMatches = sumIn === last.totalInputTokens;
  const outMatches = sumOut === last.totalOutputTokens;
  record(
    'Does totalInputTokens equal speechTokens + textTokens?',
    inMatches && outMatches ? 'YES — the flat totals are the sums' : 'NO — they differ',
    `totalInputTokens=${last.totalInputTokens} vs speech+text=${sumIn}; ` +
      `totalOutputTokens=${last.totalOutputTokens} vs speech+text=${sumOut}. ` +
      (inMatches && outMatches
        ? 'The provider summing the halves itself agrees with the vendor, so either reading works.'
        : 'The provider MUST keep summing the halves itself — reading the flat total would break the containment rule priceLeg subtracts on.'),
  );
  console.log(`\n   last usageEvent, verbatim:\n${JSON.stringify(last, null, 2).split('\n').map((l) => `   ${l}`).join('\n')}`);
}

/* -------------------------------- report -------------------------------- */

console.log('\n\n================ what this run established ================\n');
for (const f of findings) console.log(`· ${f.q}\n    ${f.answer}\n    ${f.evidence}\n`);
console.log(`Run on ${new Date().toISOString().slice(0, 10)}, region ${REGION}, via \`npm run nova:probe\`.`);
console.log('Copy these into README.md with that date and command — an undated measurement rots invisibly.');

// The probe reports; it does not judge. A rejection is a finding, not a failure,
// and exiting non-zero on one would make "the docs were wrong" look like a bug
// in this script.
process.exit(0);
