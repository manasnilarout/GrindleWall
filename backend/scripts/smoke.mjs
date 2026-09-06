/**
 * End-to-end smoke test: drives one turn over the real WebSocket protocol and
 * asserts that transcripts, audio frames, metrics, per-turn usage and the
 * end-of-conversation summary all come back.
 *
 *   node scripts/smoke.mjs [pipeline|realtime]
 *
 * Defaults to the mock providers. Override any leg to exercise real vendors
 * headlessly (text turn in, real audio out — no microphone needed):
 *
 *   STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' \
 *   LLM=google-llm LLM_MODEL='gemini-3.8-flash@minimal' \
 *   TTS=sarvam-tts TTS_MODEL=bulbul:v3 VOICE=shubh LANG_CODE=en-IN \
 *   node scripts/smoke.mjs pipeline
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';

const MODE = process.argv[2] ?? 'pipeline';
const BASE_URL = process.env.WS_URL ?? 'ws://127.0.0.1:8787/ws/session';
const AUTH_USERNAME = 'admin@magickvoice.com';

const env = process.env;
const PROMPT = env.PROMPT ?? 'Answer in one short sentence: how fast are you?';

/**
 * `LANG` is a POSIX variable the shell already sets (e.g. "en_IN.UTF-8"), so
 * reading it directly would quietly send a locale string to the vendor as a
 * language tag. `LANG_CODE` is the real knob — matching roundtrip.ts — and a
 * `LANG` that looks like a POSIX locale is ignored rather than trusted.
 */
const LANGUAGE = env.LANG_CODE ?? (isPosixLocale(env.LANG) ? undefined : env.LANG);
if (env.LANG_CODE === undefined && isPosixLocale(env.LANG)) {
  console.log(`note: ignoring LANG=${env.LANG} (shell locale). Use LANG_CODE=en-IN to set the language.`);
}

function isPosixLocale(v) {
  return typeof v === 'string' && /[_.]/.test(v);
}

const config =
  MODE === 'realtime'
    ? {
        mode: 'realtime',
        realtimeProviderId: env.REALTIME ?? 'mock-realtime',
        realtimeModelId: env.REALTIME_MODEL ?? 'mock-s2s',
        systemPrompt: env.SYSTEM ?? 'Be brief.',
        voice: env.VOICE,
        language: LANGUAGE,
        turnDetection: 'server_vad',
      }
    : {
        mode: 'pipeline',
        sttProviderId: env.STT ?? 'mock-stt',
        sttModelId: env.STT_MODEL ?? 'mock-asr',
        llmProviderId: env.LLM ?? 'mock-llm',
        llmModelId: env.LLM_MODEL ?? 'mock-chat',
        ttsProviderId: env.TTS ?? 'mock-tts',
        ttsModelId: env.TTS_MODEL ?? 'mock-voice',
        systemPrompt: env.SYSTEM ?? 'Be brief.',
        voice: env.VOICE,
        sttLanguage: env.STT_LANG ?? LANGUAGE,
        ttsLanguage: env.TTS_LANG ?? LANGUAGE,
        turnDetection: 'server_vad',
      };

for (const [prov, model, label] of [
  [env.STT, env.STT_MODEL, 'STT'],
  [env.LLM, env.LLM_MODEL, 'LLM'],
  [env.TTS, env.TTS_MODEL, 'TTS'],
  // Realtime was missing from this list, so `REALTIME=openai-realtime` with no
  // REALTIME_MODEL ran against `mock-s2s` and reported mock latency as if it
  // were the vendor's.
  [env.REALTIME, env.REALTIME_MODEL, 'REALTIME'],
]) {
  if (prov && !prov.startsWith('mock') && !model) {
    console.error(`FAIL: ${label}=${prov} needs ${label}_MODEL too (it would inherit a mock model id)`);
    process.exit(1);
  }
}

/**
 * When AUTH_PASSWORD is set the socket is gated. HMAC the password the same
 * way the login page does and pass the issued token as `?token=`.
 */
async function sessionUrl() {
  const password = env.AUTH_PASSWORD;
  const secret = env.AUTH_HMAC_SECRET;
  if (!password || !secret) return BASE_URL;
  const hmac = createHmac('sha256', secret).update(password, 'utf8').digest('hex');
  const api = (env.API_URL ?? 'http://127.0.0.1:8787') + '/api/auth/login';
  const res = await fetch(api, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: AUTH_USERNAME, hmac }),
  });
  if (!res.ok) {
    console.error(`FAIL: login returned HTTP ${res.status}`);
    process.exit(1);
  }
  const { token } = await res.json();
  const join = BASE_URL.includes('?') ? '&' : '?';
  return `${BASE_URL}${join}token=${encodeURIComponent(token)}`;
}

const ws = new WebSocket(await sessionUrl());
const seen = { audioFrames: 0, audioBytes: 0, transcripts: [], metrics: null, started: null, usage: null, summary: null };

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const timeout = setTimeout(() => fail('timed out waiting for the session summary'), Number(env.TIMEOUT_MS ?? 30000));

ws.on('open', () => ws.send(JSON.stringify({ type: 'start', config })));

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    seen.audioFrames += 1;
    seen.audioBytes += data.length;
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === 'session_started') {
    seen.started = msg;
    console.log(`session ${msg.sessionId} · ${msg.mode} · ${msg.label}`);
    ws.send(JSON.stringify({ type: 'user_text', text: PROMPT }));
  } else if (msg.type === 'transcript' && msg.final) {
    seen.transcripts.push(`${msg.role}: ${msg.text}`);
  } else if (msg.type === 'error') {
    fail(msg.message);
  } else if (msg.type === 'metrics') {
    seen.metrics = msg;
  } else if (msg.type === 'usage') {
    seen.usage = msg.usage;
    // Usage is the last per-turn frame, so the conversation can be wound up here.
    ws.send(JSON.stringify({ type: 'end_conversation' }));
  } else if (msg.type === 'session_summary') {
    seen.summary = msg.summary;
    clearTimeout(timeout);
    ws.close();
  }
});

ws.on('error', (err) => fail(`socket: ${err.message}`));

ws.on('close', () => {
  const problems = [];
  if (!seen.started) problems.push('no session_started');
  if (seen.audioFrames === 0) problems.push('no audio frames');
  if (!seen.transcripts.some((t) => t.startsWith('assistant:'))) problems.push('no assistant transcript');
  if (!seen.metrics) problems.push('no metrics');
  if (seen.metrics && seen.metrics.derived.timeToFirstAudioMs === undefined) problems.push('no time-to-first-audio');
  if (!seen.usage) problems.push('no per-turn usage');
  if (!seen.summary) problems.push('no session_summary after end_conversation');

  const s = seen.summary;
  if (s) {
    if (s.turnCount !== 1) problems.push(`summary turnCount ${s.turnCount}, expected 1`);
    if (!s.recordId) problems.push('summary has no recordId to persist under');
    // Totals are summed from the per-turn rows, so they must agree with them.
    const perTurn = s.turns.reduce((n, t) => n + t.costUsd, 0);
    if (Math.abs(perTurn - s.costUsd) > 1e-9) {
      problems.push(`summary cost ${s.costUsd} != sum of turns ${perTurn}`);
    }
    const legs = MODE === 'realtime' ? ['realtime'] : ['stt', 'llm', 'tts'];
    for (const leg of legs) {
      if (!seen.usage.legs.some((l) => l.leg === leg)) problems.push(`usage is missing the ${leg} leg`);
      if (!s.totals.some((l) => l.leg === leg)) problems.push(`summary totals are missing the ${leg} leg`);
    }
  }

  console.log(`\ntranscripts:`);
  for (const t of seen.transcripts) console.log(`  ${t}`);
  console.log(`\naudio: ${seen.audioFrames} frames / ${seen.audioBytes} bytes (${(seen.audioBytes / 2 / 24000).toFixed(2)}s)`);
  console.log(`metrics:`, seen.metrics?.derived);
  console.log(`marks:`, seen.metrics?.marks.map((m) => `${m.name}@${m.atMs}ms`).join(' '));

  if (seen.usage) {
    console.log(`\nusage (turn ${seen.usage.turnId}):`);
    for (const l of seen.usage.legs) {
      const cost = l.cost ? `${l.cost.currency} ${l.cost.amount} (${l.cost.rate})` : `UNPRICED: ${l.unpricedReason}`;
      console.log(`  ${l.leg.padEnd(8)} ${l.providerId}:${l.modelId} in=${l.inputUnits} out=${l.outputUnits} ${l.unit} [${l.source}] ${cost}`);
    }
  }
  if (seen.summary) {
    console.log(`\nsummary ${seen.summary.recordId}: ${seen.summary.turnCount} turn(s), $${seen.summary.costUsd}` +
      (seen.summary.unpriced.length ? ` (unpriced: ${seen.summary.unpriced.join(', ')})` : ''));
  }

  if (problems.length) fail(problems.join('; '));
  console.log(`\nPASS (${MODE})`);
});
