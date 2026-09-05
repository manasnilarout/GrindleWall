# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A harness for A/B-testing voice AI providers on latency and audio quality across two
architectures — **realtime** (one native speech-to-speech model) and **pipeline**
(STT → LLM → TTS) — behind one interface so the numbers are comparable. See `README.md`
for the measured vendor findings; they are the record of what the live APIs actually
accept and should be updated when re-measured.

Not a git repository. `backend/` and `frontend/` are two independent npm projects with no
workspace root (the root `package-lock.json` is empty).

## Commands

```bash
cd backend  && npm install && cp .env.example .env && npm run dev   # :8787
cd frontend && npm install && npm run dev                           # :5173, proxies /api + /ws to :8787
```

Typecheck (there is no linter and no test runner — verification is via the scripts below):

```bash
cd backend  && npm run typecheck        # tsc --noEmit over src/ and scripts/
cd frontend && npm run typecheck
```

Verification scripts, all in `backend/`:

| Command | Needs a key | What it proves |
|---|---|---|
| `npm run smoke` | no | one full turn over the real WS protocol, both modes (needs `npm run dev` running) |
| `npm run gemini:selftest` | no | Gemini SSE/wire handling against a local fake |
| `npm run usage:selftest` | no | cost arithmetic, persistence, secret redaction — vs hand-computed vendor denominations |
| `npm run turn:selftest` | no | turn attribution: silence, barge-in, overlapping turns, TTS failure, tails |
| `npm run murf:selftest` | no | Murf message handling against a local fake |
| `npm run roundtrip` | yes | any TTS → STT pair: synthesise, stream back at real time, print transcript + latency |
| `npm run sarvam` / `npm run cartesia` | yes | preset `roundtrip` invocations |
| `npm run gemini:live [model\|all]` | yes | real TTFT per catalog model variant |
| `npm run murf:probe` / `npm run murf:voices` | yes | resolve Murf's undocumented request shape / real voice ids |

And in `frontend/`: `npm run render-check` server-renders the usage panels against a real or synthetic
session record. `tsc` did not catch this project's last UI crash, so type-checking a component is not
evidence that it renders.

Scripts are configured by env vars, not flags — `TTS`, `TTS_MODEL`, `STT`, `STT_MODEL`,
`LLM`, `LLM_MODEL`, `VOICE`, `LANG_CODE`, `STT_LANG`, `TTS_LANG`, `PROMPT`. (`LANG` is the
shell's own POSIX locale — `smoke.mjs` ignores it when it looks like one.) To run a
single case, invoke the script directly:

```bash
cd backend
TTS=cartesia-tts TTS_MODEL=sonic-3.6 STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' \
  npx tsx scripts/roundtrip.ts "text to say" en

STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' LLM=google-llm \
LLM_MODEL='gemini-3.1-flash-lite@minimal' TTS=sarvam-tts TTS_MODEL=bulbul:v3 \
  node scripts/smoke.mjs pipeline
```

`smoke.mjs` refuses a real provider given without its `*_MODEL` (it would silently inherit
a mock model id).

## Architecture

**Two session kinds, one interface.** `VoiceSession` (`backend/src/providers/types.ts`) is
implemented by both a native realtime provider and by `PipelineSession`. Everything above
it — `session-socket.ts`, the metrics, the frontend — is identical for both and cannot tell
which it is driving. Preserve that: anything architecture-specific belongs inside a
provider module.

**Flow:** browser `MicRecorder` → WS binary frames → `handleSocket` →
`createSession()` (factory) → `PipelineSession` fans out to STT/LLM/TTS providers → audio
back as binary frames → `AudioSink`.

Key files:

- `backend/src/shared/protocol.ts` — the wire contract, and `CANONICAL_SAMPLE_RATE`.
  **Mirrored by copy** to `frontend/src/lib/protocol.ts`; after editing it run
  `cd frontend && npm run sync-protocol`. Never hand-edit the frontend copy.
- `backend/src/providers/catalog.ts` — single source of truth for the UI's toggles (24
  providers, their models, voices, languages, `envKeys`). Served via `GET /api/catalog`
  with readiness computed per env var. Entries are **measured, not assumed**: unsupported
  model/setting pairings are absent so the UI cannot produce a 400.
- `backend/src/providers/factory.ts` — the registration point and the only session entry
  point. It validates provider id, model id and required env vars before constructing.
- `backend/src/pipeline/PipelineSession.ts` — turn assembly, history, barge-in, metric
  marks. Provider modules do one job each and rely on this.
- `backend/src/metrics/TurnMetrics.ts` — one per turn; records monotonic marks, derives the
  comparison numbers. First occurrence of a mark wins.
- `backend/src/audio/pcm.ts` — `resamplePcm16`, `stripWavHeader`, RMS, mock tone generation.
- `backend/src/audio/vad.ts` — energy speech-end detector, for vendors that publish no
  `speech_end` event of their own.
- `backend/src/pricing/rates.ts` — every vendor rate with its source URL, the date it was read, and a
  `confidence` flag. Dated step changes (Google's promotional Flash rate) are encoded. Overridable via
  `CARTESIA_USD_PER_CREDIT` / `USD_PER_INR`.
- `backend/src/pricing/UsageLedger.ts` — one per conversation; prices each turn as it lands and sums
  the totals **from the per-turn rows**, so the summary can never disagree with the table above it.
- `backend/src/store/SessionStore.ts` — one JSON file per conversation under `data/sessions`, rewritten
  after every turn.

### Invariants

- **Audio is PCM16 LE mono @ 24 kHz (`CANONICAL_SAMPLE_RATE`) at every session boundary**,
  in both directions, always. A vendor wanting 16 kHz or µ-law is adapted inside its own
  module via `resamplePcm16()`, against the `sampleRate` in its options rather than the
  constant, so a provider stays correct if the boundary is ever reconfigured.
- **t0 for every latency number is the moment the user stopped speaking** — the
  `user_speech_end` mark, set by `beginTurn()`. Vendor server-side VAD supplies it where
  available (Sarvam `vad.speech_end`), the local `SpeechEndDetector` where not (Cartesia).
  Same definition, different detector; keep it that way rather than moving t0.
- **Providers read keys from `ctx.credentials` / `opts.credentials`, never `process.env`**,
  so sessions stay swappable and scripts can inject. Process-level configuration is the
  exception and reads it directly: `config.ts` (port, CORS, logging), `factory.ts` and
  `catalog.ts` (readiness), `pricing/rates.ts` (FX and credit rates), `store/SessionStore.ts`
  (record directory).
- **Vendor connection setup is inside the measured window.** `tts_request_sent` is marked
  before `tts.open()`, and TTS `open()` resolves immediately with text queued until the
  socket handshake completes. Don't "optimise" by pre-connecting outside the clock.
- **Stream, don't buffer.** TTS must emit its first frame as soon as it has one; TTFB is the
  whole point. `cancel()` / `abort()` must be immediate — barge-in depends on it.
- Reasoning depth is encoded in the model id as a `@variant` suffix
  (`gemini-3.8-flash@off`), split by the provider. Support is per-model and contradicts the
  docs; `catalog.ts` lists only verified combinations.
- Mock providers stay registered permanently. When a real provider misbehaves, swap one leg
  to mock to find out which leg is at fault. They also exercise every callback, so they are
  the reference implementations for a new provider.
- **Usage is counted in the unit the vendor bills in** — STT in seconds of audio, LLM in tokens, TTS
  in characters. Only the LLM leg is denominated in tokens; flattening the others into a single
  "token" number would be a fiction. Every `LegUsage` carries `source: 'vendor' | 'local'`, and a
  locally-estimated count is never rendered as a measurement (the UI marks it `~`).
- **Every cost is carried in both USD and INR.** `LegCost.currency` names the one the vendor actually
  bills in — that figure is exact, the other went through the assumed FX rate (`USD_PER_INR`, default
  ₹94.43/$1) and is dimmed in the UI. There is no FX feed; the rate travels in every session summary
  so a stale one is visible rather than baked in.
- **A turn is only billed once it runs.** `PipelineSession` keeps an explicit `Turn` with a
  `pending` phase (t0 marked, transcript not yet known) and a `running` phase. A pending turn
  that never runs — silence, a false endpoint, an interrupt — is *abandoned*, handing its
  banked STT audio back so the next turn carries it. Billing a pending turn invents turns;
  stranding one shifts every later turn's audio **and freezes t0**, which corrupts the latency
  numbers, not just the money.
- **Audio streamed outside any turn is still metered by the vendor**, so what arrives after the
  last turn is emitted as a tail record carrying only an STT leg.
- **Session records hold no credentials.** Only the `StartConfig` (provider/model ids, the system
  prompt, language) plus usage and cost. The system prompt *is* persisted — that is deliberate,
  since it is what produced the numbers — so treat `data/sessions/` as conversation content.
  Records are ~1-3 KB per turn and kept forever unless `SESSION_MAX_RECORDS` is set.
- **Errors and logs are scrubbed before they reach the browser** (`redactSecrets`). `credentials()`
  hands every provider the whole environment, so one adapter interpolating its options into an
  error message would otherwise send every key in `.env` to the client.
- **A leg with no rate on file is never priced at zero.** It is reported as unpriced and the session
  total is labelled a floor. Costing happens above the provider layer — providers report raw counts
  and never learn what anything is worth.

### Adding a provider

1. `implemented: true` on its `catalog.ts` entry (with correct `envKeys`).
2. Implement the slot interface from `types.ts` and `registerX(new XProvider())` in
   `factory.ts`.
3. Add a rate to `pricing/rates.ts` with its source URL and the date you read it. Skipping this is
   allowed — the leg reports as unpriced rather than as free.
4. If the vendor's API returns token counts, call `events.onUsage()` (see `GeminiLlmProvider`).
   Otherwise `PipelineSession` estimates and flags the row `local`.

Nothing else changes — the frontend renders from the catalog.

### Text buffering is a quality trap, not just a latency dial

Streaming TTS vendors expose text-aggregation knobs (`max_buffer_delay_ms`,
`min_buffer_size`). Setting the delay to `0` makes Cartesia's Sonic voice **every token as
its own utterance** — 2.6× too much audio with mangled prosody — because this pipeline
streams raw LLM tokens with no sentence aggregation upstream. Cartesia is pinned at
`250ms`; Murf is left at the vendor default with only a small `min_buffer_size`. Do not
lower these to chase TTFB without measuring rendered audio duration against a one-shot
reference.

### Unverified: Murf

`MurfTtsProvider` has still never run against the live API. A `MURF_API_KEY` is now present in
`backend/.env`, so the only thing standing between this and verification is running the probe. Murf's
docs disagree with shipped third-party clients on the `voiceId` key, the model string and
the auth mechanism. Its 27 self-test checks pass against a local fake, which proves nothing
about what Murf accepts. `npm run murf:probe` permutes the ambiguities against the real API
and prints the constants to set; its catalog voice ids are doc-derived until
`npm run murf:voices` replaces them. Treat any Murf constant as a guess until then.
