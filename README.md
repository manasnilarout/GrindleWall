# Voice provider bench

A small harness for A/B-ing voice AI providers on **latency**, **audio quality** and **how human they sound** —
across the two architectures that matter:

| Architecture | What it is |
|---|---|
| **Realtime** | One native speech-to-speech model (OpenAI Realtime, Gemini Live, Nova Sonic, ElevenLabs Agents) |
| **Pipeline** | STT → LLM → TTS stitched together (Deepgram → Claude → ElevenLabs, etc.) |

Both implement the **same `VoiceSession` interface** and emit the **same metrics**, so the numbers are
comparable and the frontend never knows which one it is talking to.

```
frontend/  Vite + React. Provider toggle → model → prompt widget → conversation + latency table.
backend/   Node + TS. Factory-injected providers, one WebSocket per session.
```

## Run it

```bash
# terminal 1
cd backend && npm install && cp .env.example .env && npm run dev

# terminal 2
cd frontend && npm install && npm run dev     # http://localhost:5173
```

Ships with mock providers for every slot, so it works end to end with **no API keys**:
click **Connect**, then **Start mic**, or just type a turn. You'll hear synthetic beeps and get real
latency numbers for the transport.

```bash
cd backend
npm run smoke            # one full turn over the real WS protocol, both modes
npm run gemini:selftest  # Gemini wire handling, no key needed
npm run cartesia         # Sonic -> Ink round trip      (needs CARTESIA_API_KEY)
npm run sarvam           # Bulbul -> Saaras round trip  (needs SARVAM_API_KEY)
npm run roundtrip        # any TTS -> STT pair, see below
npm run murf:selftest    # Murf message handling, no key needed
```

## The wire protocol

One WebSocket per session at `ws://localhost:8787/ws/session`.

- **Binary frames** are raw audio in both directions: **PCM16 LE, mono, 24 kHz**. Always. Providers that
  want 16 kHz or µ-law get adapted inside their own module (`backend/src/audio/pcm.ts`).
- **Text frames** are JSON control messages. Types live in `backend/src/shared/protocol.ts`
  (mirrored to `frontend/src/lib/protocol.ts` — `npm run sync-protocol` in `frontend/` re-copies it).

Client → server: `start`, `user_text`, `commit_audio`, `interrupt`, `end_conversation`, `stop`

Server → client: `session_started`, `transcript`, `turn_start`/`turn_end`, `metrics`, `usage`,
`session_summary`, `log`, `error`, `session_closed`

`end_conversation` is the one that asks for the bill: the server closes the providers, prices the
conversation, files it, then sends `session_summary` followed by `session_closed`. `stop` drops the
session without a report.

## What gets measured

Per turn, t0 = **the moment the user stopped speaking**:

| Metric | Meaning |
|---|---|
| `timeToFirstAudioMs` | t0 → first audio byte leaves the server. **The number that matters.** |
| *TTFA (client)* | t0 → first sample actually **audible** in the browser. Includes network + jitter buffer. |
| `sttLatencyMs` | t0 → final transcript (pipeline only) |
| `llmTtftMs` | LLM request sent → first token |
| `ttsTtfbMs` | TTS request sent → first audio frame |
| `totalTurnMs` | t0 → last audio byte |

The client-measured TTFA is the honest one — it is what a user perceives. The server number isolates
vendor latency from your network. The table exports to JSON for offline comparison.

Audio quality and human-ness stay subjective on purpose: pick a provider, run the same prompt, listen.
The **Naturalness probe** preset in the prompt widget is there for that.

## Ending a conversation, and what it cost

**End conversation** (next to Connect) closes the providers, bills the whole conversation and shows
the breakdown. It is deliberately distinct from **Disconnect**, which just drops the socket. The
socket is held open until the summary arrives — closing it first would leave the server with a report
and nowhere to send it.

Records are written to `backend/data/sessions/<id>.json` **after every turn**, not only at the end, so
a conversation that is never formally ended — closed tab, lost connection, crashed process — still
leaves its token counts on disk. Writes are serialized and atomic (temp file, then rename): two saves
landing in the same tick used to interleave into a file that would not parse, and the damaged record
then vanished from the listing rather than reporting itself.

A record holds no API keys — provider/model ids, the system prompt, and the usage numbers. It does
hold the prompt, deliberately, since that is what produced them. Expect ~1-3 KB per turn, kept
indefinitely; `SESSION_DIR` moves them and `SESSION_MAX_RECORDS` caps them (off by default — silently
deleting a measurement someone is mid-comparison on is worse than the disk use). Past conversations are listed in the UI and served from
`GET /api/sessions` and `GET /api/sessions/:id`.

### Three legs, three billing units

Only the LLM leg is denominated in tokens. Reporting the other two as "tokens" would be a fiction, so
each is counted in the unit its vendor actually meters:

| Leg | Unit | Where the number comes from |
|---|---|---|
| STT | seconds of audio streamed in | counted locally (silence included — vendors bill it) |
| LLM | tokens | **vendor-reported** via Gemini's `usageMetadata`; estimated at ~4 chars/token when an API returns nothing |
| TTS | characters sent to synthesise | counted locally, at the point the text is handed to the vendor |
| Realtime | seconds of audio in and out | counted locally |

Every row carries a `source` of `vendor` or `local`, and the UI marks locally-counted numbers with a
`~`. A guess is never displayed as a measurement. Gemini's thinking tokens are billed at the output
rate, so they are folded into `outputUnits` and also broken out on their own — on
`gemini-3.5-flash-lite@high`, a measured turn spent **308 of its 335 output tokens (92%) on thinking**,
making it ~24× the cost of the same turn at `@minimal`. That is the single largest cost dial here.

### Rates are read off vendor pages, not guessed

`backend/src/pricing/rates.ts` carries every rate with its source URL, the date it was read, and a
`confidence` flag. `GET /api/pricing` serves the table so any number in the UI can be traced back.

| Provider | Rate | Source |
|---|---|---|
| Gemini 3.6/3.7/3.8 Flash | $0.75 in / $3.75 out per 1M — **promotional, doubles 2027-01-01** | ai.google.dev |
| Gemini 3.5 Flash | $1.50 / $9.00 per 1M | ai.google.dev |
| Gemini 3.5 Flash Lite | $0.30 / $2.50 per 1M | ai.google.dev |
| Gemini 3.1 Flash Lite | $0.25 / $1.50 per 1M | ai.google.dev |
| Sarvam Bulbul v3 | ₹30 per 10K characters | docs.sarvam.ai |
| Sarvam Saaras | ₹30 per hour of audio | docs.sarvam.ai |
| Cartesia Sonic | ~1 credit per character | docs.cartesia.ai |
| Cartesia Ink-2 / Ink-whisper | 3 / 1 credits per second | docs.cartesia.ai |
| Murf Falcon | $0.03 per 1K characters — **flagged ambiguous** | help.murf.ai |

Three things the table is honest about rather than hiding:

- **Google's Flash rate is promotional.** The step change to $1.50/$7.50 on 2027-01-01 is encoded, so
  estimates stay correct instead of silently going stale.
- **Cartesia credits are plan-dependent.** The default is the Pro tier ($5/100K); set
  `CARTESIA_USD_PER_CREDIT` for yours.
- **Sarvam bills in rupees, everyone else in dollars.** Every cost is reported in **both** USD and
  INR, with the vendor's own currency shown bold and the converted figure dimmed, so a conversion is
  never mistaken for a quote. There is no FX feed — the assumed rate (default ₹94.43 per $1) is
  printed in every summary; set `USD_PER_INR` to change it.
- **Murf's own sources disagree**: the help centre publishes $0.03/1K characters while the product page
  markets Falcon at "1 cent per minute". That leg is flagged `ambiguous` in the UI.

A leg with no rate on file is never priced at zero — it is listed as unpriced and the session total is
labelled a **floor, not a bill**.

### Verifying it

```bash
cd backend  && npm run turn:selftest    # 32 checks on turn attribution, no key, no network
cd backend  && npm run usage:selftest   # 86 checks on arithmetic, persistence and redaction
cd backend  && npm run gemini:selftest  # 37 checks incl. token-usage parsing
cd backend  && npm run smoke            # usage + summary over the real WS protocol
cd frontend && npm run render-check     # actually renders the panels (tsc did not catch the last UI crash)
```

`turn:selftest` encodes bugs that actually shipped — silence stranding a turn, a second question
arriving mid-answer, a TTS failure losing the model's token counts, barge-in inventing a turn — and
each case was confirmed to fail against the code that had the bug. `usage:selftest` derives every
expectation from the vendor's published denomination — ₹30 per 10K
characters, 3 credits per second — rather than from what the code produces, so a unit slip fails there
instead of showing a plausible number in the UI. What it cannot prove is that the **rates themselves**
are current; they are dated in `rates.ts` and worth re-reading before quoting a number.


## Sarvam (first integration)

Both Sarvam legs are wired and both run over **WebSockets**, streaming in and out.

| Leg | Model | Endpoint |
|---|---|---|
| STT | `saaras:v3-realtime` / `v4-realtime` | `wss://api.sarvam.ai/speech-to-text-realtime/ws` |
| TTS | `bulbul:v3` (also v3-beta, v2) | `wss://api.sarvam.ai/text-to-speech/ws` |

```bash
echo 'SARVAM_API_KEY=your_key' >> backend/.env
cd backend && npm run sarvam       # round-trip check, no microphone needed
```

`npm run sarvam` exercises the **shipped provider classes**: Bulbul synthesizes a
sentence, the PCM is streamed back into Saaras at real time, and you get the transcript
plus both latency numbers. It validates auth, the message protocol, audio format and
resampling in one shot. Pass your own text and language:

```bash
TTS=sarvam-tts TTS_MODEL=bulbul:v3 STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' \
  npx tsx scripts/roundtrip.ts "नमस्ते, आप कैसे हैं?" hi-IN
VOICE=ritu STT_MODEL='saaras:v4-realtime@balanced' npm run sarvam
```

**Bulbul v3** — 37 speakers (all selectable in the UI), 11 languages. Requested as
`linear16` @ 24 kHz, which *is* the bench's canonical format, so audio arrives with zero
transcoding and zero resampling — nothing between the vendor's samples and your ears.
Chunking is tuned for latency (`min_buffer_size: 50`).

**Saaras** — 14 language options including `auto` detect, and the `stream_type` latency/accuracy
tradeoff is exposed as a UI-selectable model variant (`saaras:v3-realtime@fast` vs
`@balanced`). Saaras accepts only 16 kHz/8 kHz, so canonical audio is downsampled on the
way in. Its **server-side VAD supplies `vad.speech_end`, which becomes t0** for every
latency measurement — the honest definition of "the user stopped talking".

STT and TTS languages are chosen **independently**, so `auto` in / `hi-IN` out is a valid
combination to test.

### Everything is a WebSocket, except the LLM

Browser ↔ backend, Saaras, and Bulbul are all full-duplex WebSockets. The LLM leg is the
exception: no major vendor offers a WebSocket chat API, so LLM providers stream over HTTP
(SSE). That leg is off the audio path — it produces text, and its only latency contribution
is `llmTtftMs`, which is measured separately.

Keep **Mock (echo)** selected as the LLM while evaluating Sarvam in isolation: it replies
with a fixed sentence at a fixed ~180ms, so any variance you see in TTFA is Sarvam's, not
a model's. Switch to Gemini once you want the real three-leg number.

## Gemini (LLM leg)

Gemini Flash is the LLM, so the headline combination is **Saaras → Gemini Flash → Bulbul**,
all three selectable from the UI.

```bash
echo 'GOOGLE_API_KEY=your_key' >> backend/.env
cd backend
npm run gemini:selftest      # 25 checks, no key or network needed
npm run gemini:live all      # real TTFT for all 26 verified combinations
```

### Reasoning depth is the latency dial

Thinking dominates TTFT — often more than a second, which for a voice loop is the whole
budget. So reasoning level is part of the **selectable model id** and shows up in the UI:

```
gemini-3.1-flash-lite@minimal      thinkingConfig.thinkingLevel = "minimal"
gemini-3.8-flash@off               thinkingConfig.thinkingBudget = 0
```

The two fields are mutually exclusive; the API rejects a request carrying both.

### Support does not follow the docs — the catalog is measured, not assumed

Every entry in `catalog.ts` was verified against the live API. Unsupported pairings are
simply absent, so the UI cannot produce a 400. What the probing found:

| Model | Best voice setting | Median TTFT | Notes |
|---|---|---|---|
| `gemini-3.1-flash-lite` | `@minimal` | **858ms** | fastest measured; `@off` also works |
| `gemini-3.5-flash-lite` | `@minimal` | 946ms | `@off` **rejected** |
| `gemini-3.5-flash` | `@off` | 980ms | both fields work |
| `gemini-3.6-flash` | `@minimal` | 1160ms | `@off` **rejected** |
| `gemini-3.8-flash` | `@off` | 1186ms | `@minimal` **rejected** |
| `gemini-3.7-flash` | `@low` | 1712ms | can never reach 0 thinking tokens |

Three things the documentation got wrong for these models:

- **`minimal` is rejected by `gemini-3.8-flash` and `gemini-3.7-flash`**, despite the docs
  saying Flash models support it and default to it.
- **`thinkingBudget: 0` is rejected by `gemini-3.6-flash` and `gemini-3.5-flash-lite`**, and
  on `gemini-3.7-flash` it is accepted but ignored — that model always thinks.
- **`gemini-2.5-flash` and `-lite` now return 404** ("no longer available to new users"), so
  they are not offered at all.

Re-measure at any time with `npm run gemini:live all`; latency numbers are medians of 3
runs and move around by a couple hundred ms.

Two more behaviours worth knowing:

- **`temperature` is not sent unless you set it.** Gemini 3 warns that moving off the
  default can cause looping or degraded output.
- **Reasoning parts never reach the TTS.** Streamed parts flagged `thought: true` are
  filtered, so only speakable answer text is synthesised.
- **A short reply arrives in essentially one chunk**, so TTFT ≈ full generation time.
  Streaming buys you little on one-sentence answers; the win comes from short prompts and
  no thinking.

### Testing the real stack headlessly

`scripts/smoke.mjs` drives the actual WebSocket protocol with any provider combination, so
you can measure real vendor latency from a typed turn with no microphone:

```bash
cd backend
STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' \
LLM=google-llm LLM_MODEL='gemini-3.1-flash-lite@minimal' \
TTS=sarvam-tts TTS_MODEL=bulbul:v3 VOICE=shubh LANG=en-IN \
node scripts/smoke.mjs pipeline
```

It prints every metric mark, so you can see exactly where the time went. Swap any leg back
to a mock to isolate which vendor is responsible.

## Cartesia (Sonic TTS + Ink STT)

**Sonic is TTS-only** — Cartesia's speech recognition is a separate family, `Ink`, so the
input leg uses `ink-2` / `ink-whisper`. Both legs are WebSockets.

| Leg | Models | Endpoint |
|---|---|---|
| TTS | `sonic-3.6` · `3.5` · `3` · `sonic-turbo` · `sonic-2` | `wss://api.cartesia.ai/tts/websocket` |
| STT | `ink-2` · `ink-whisper` | `wss://api.cartesia.ai/stt/websocket` |

```bash
echo 'CARTESIA_API_KEY=your_key' >> backend/.env
cd backend && npm run cartesia      # Sonic -> Ink round trip
```

Both legs run natively at **24 kHz pcm_s16le** — the bench's canonical format — so neither
transcodes nor resamples. STT audio goes up as raw binary frames, not base64.

### `max_buffer_delay_ms: 0` is a quality trap

This is the one setting that matters most, and the obvious value is wrong. Measured on one
sentence fed word by word (one-shot reference renders **3.44s** of audio):

| `max_buffer_delay_ms` | TTFB | Audio rendered |
|---|---|---|
| `0` | 88ms | **9.20s** — every token voiced as its own utterance |
| `100` | 118ms | 3.60s |
| **`250`** (what we use) | 110ms | 3.52s |
| default (`3000`) | 105ms | 3.60s |

With `0`, Sonic renders 2.6x too much audio with word-isolated prosody, and words get
dropped when transcribed back ("the date, uh, purchase"). Pipecat can afford `0` because it
aggregates text into sentences upstream; this pipeline streams raw LLM tokens, so Sonic has
to do the aggregating. **250ms buys correct prosody for about 20ms of TTFB.** Sarvam's
Bulbul is unaffected — its `min_buffer_size` already aggregates.

### Two protocol quirks the adapter absorbs

- **Cartesia emits many `is_final: true` messages per utterance** — one per word or phrase,
  meant to be concatenated (`"Our"` / `"refund"` / `"window is"` ...). Sarvam sends one
  final per whole turn. Forwarding Cartesia's as finished turns would fire one LLM call per
  word, so segments are accumulated and surfaced as partials; the real boundary is
  `flush_done`, the ack of `finalize`.
- **There is no server-side speech-end event.** A local energy VAD (`src/audio/vad.ts`)
  supplies one, which both marks t0 for the metrics and triggers `finalize` instead of
  waiting on Cartesia's silence timer. Sarvam uses its own `vad.speech_end`, so be aware the
  two vendors' t0 comes from different sources — same definition, different detector.

Control frames are **raw text**, not JSON: `finalize` then `close`.

### Measured

`ink-2` streams word-level segments from ~1.0s; `ink-whisper` returns whole-utterance
finals but not until ~3.3s, so `ink-2` is the voice-agent choice. Round trips, all passing:

| Combination | Transcript accuracy |
|---|---|
| Sonic -> Ink | 11/11 words |
| Bulbul -> Ink | 11/11 words |
| Sonic -> Saaras | 10/11 (`thirty` -> `30`) |
| Bulbul -> Saaras | 10/11 (`thirty` -> `30`) |

Through the full pipeline with Gemini, Sonic added only ~95ms on top of the LLM's TTFT
(TTFA 1110ms, of which `llmTtftMs` was 1015ms).

Any TTS and STT can be paired across vendors — that is the point:

```bash
cd backend
TTS=cartesia-tts TTS_MODEL=sonic-3.6 STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' \
  npx tsx scripts/roundtrip.ts
```

## Murf (Falcon 2 TTS)

**Murf is TTS only** — there is no Murf STT, so pair it with Saaras or Ink on the input leg.

| Leg | Models | Endpoint |
|---|---|---|
| TTS | `falcon-2` · `gen2` | `wss://global.api.murf.ai/v1/speech/stream-input` |

```bash
echo 'MURF_API_KEY=your_key' >> backend/.env
cd backend
npm run murf:selftest   # 27 checks, no key needed — message handling
npm run murf:probe      # resolves the request-shape ambiguities (needs key)
npm run murf:voices     # real voice ids, prints a paste-ready catalog block
```

Requested as raw `PCM`, `MONO`, 24 kHz — the bench's canonical format, so no resampling.
A RIFF header is stripped if one shows up anyway (`stripWavHeader`, shared with Sarvam).

### This one is not yet verified against the live API

It has still never been run against the live API. A `MURF_API_KEY` is now present in `backend/.env`,
so `npm run murf:probe` will settle this in one run — until then every Murf constant is a guess.
Unlike the other vendors, **Murf's own docs disagree with shipped third-party clients on three
details**:

| Detail | Murf docs (what we send) | Alternate seen in the wild |
|---|---|---|
| voice_config key | `voiceId` | `voice_id` |
| model string | `falcon-2` | `FALCON` / `Falcon` |
| auth | `api-key` header | `api-key` query param |

Guessing here would be a coin flip, so instead `npm run murf:probe` permutes all of them
against the live API, reports which combination works, and prints the exact constants to
set in `MurfTtsProvider.ts`. It also re-runs the buffering check below. Add a key, run it
once, and the ambiguity is gone.

The voice ids and locales in the catalog are likewise doc-derived, not API-derived — the
catalog entry says so. `npm run murf:voices` replaces them with real ones.

### Buffering: pre-empting the Cartesia trap

Murf exposes the same text-buffering knobs as Cartesia (`min_buffer_size`,
`max_buffer_delay_in_ms`), where setting the delay to `0` made Sonic voice every token as
its own utterance — 2.6x too much audio and mangled prosody. One third-party Murf client
sets `max_buffer_delay_in_ms: 0`. Rather than repeat that mistake blind, this provider
**leaves the delay at Murf's default** and sets only a small `min_buffer_size`. Stage 3 of
`murf:probe` reports rendered audio duration per setting against a one-shot reference, so
you can confirm or tune it with numbers instead of assumptions.

### What the 27 self-test checks do and do not prove

They run the real provider against a local fake speaking Murf's dialect, covering base64
decoding, the `final` flag, `voice_config` ordering, `end` flags, one shared `context_id`,
header-not-URL auth, RIFF stripping, error surfacing, barge-in, and text queued before the
socket opens. **They cannot prove Murf accepts our request shape** — a fake I wrote will
happily accept whatever I send. That is exactly the gap `murf:probe` closes, and it is the
lesson from the Gemini `thinkingLevel` bug: 25 green checks against my own assumption told
me nothing about what Google would accept.

## Adding a provider

Two steps. Nothing else in the app changes.

**1. Flip it on in the catalog** — `backend/src/providers/catalog.ts` already lists 24 providers with
their models, voices and required env vars. Set `implemented: true` on the one you're wiring.

**2. Implement the interface and register it** — `backend/src/providers/factory.ts`:

```ts
import { DeepgramSttProvider } from './stt/DeepgramSttProvider.js';
registerStt(new DeepgramSttProvider());
```

The interfaces (`backend/src/providers/types.ts`) are deliberately small:

| Slot | Interface | You implement |
|---|---|---|
| Realtime | `RealtimeProvider` | `createSession(ctx) → VoiceSession` |
| STT | `SttProvider` | `open(opts, events) → { pushAudio, finalize, close }` |
| LLM | `LlmProvider` | `stream(opts, messages, events) → { abort }` |
| TTS | `TtsProvider` | `open(opts, events) → { pushText, flush, cancel, close }` |

Contract for every implementation:

- **Audio in and out is PCM16 LE mono @ 24 kHz.** Resample at your module's edge with
  `resamplePcm16()` against the `sampleRate` in your options.
- **Stream, don't buffer.** TTS must emit its first frame as soon as it has one; the whole point is TTFB.
- **`cancel()` / `abort()` must be immediate** — barge-in depends on it.
- **Read keys from `ctx.credentials`**, never `process.env` directly, so sessions stay swappable.

`PipelineSession` handles turn assembly, history, metric marks and barge-in for you — an STT/LLM/TTS
module only has to do its one job. Look at the `Mock*` providers as reference implementations; they
exercise every callback.

The mock providers stay registered permanently: when a real provider misbehaves, swap one slot back to
mock to find out which leg is at fault.
