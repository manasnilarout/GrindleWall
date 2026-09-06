# Grindelwald

**Grindelwald**, powered by **MagickVoice** — a Harry Potter–themed
harness for A/B-ing voice AI providers on **latency**, **audio quality** and **how human they sound** —
across the two architectures that matter:

| Architecture | What it is |
|---|---|
| **Realtime** | One native speech-to-speech model (OpenAI Realtime, Gemini Live, Nova Sonic, ElevenLabs Agents) |
| **Pipeline** | STT → LLM → TTS stitched together (Deepgram → Claude → ElevenLabs, etc.) |

Both implement the **same `VoiceSession` interface** and emit the **same metrics**, so the numbers are
comparable and the frontend never knows which one it is talking to.

```
frontend/  Vite + React. Parchment bench UI — named rigs → latency waterfall → compare runs → live console.
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

Client → server: `start`, `user_text`, `start_recording`, `commit_audio`, `interrupt`, `end_conversation`, `stop`

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

### The UI

The bench is branded **Grindelwald, powered by MagickVoice**: a light parchment theme with house-gold
accents, Cinzel on the brand name, and small Harry Potter icons on every panel. The MagickVoice logo
sits in the top bar next to the name.

The frontend is organised around **rigs** — named provider combinations you switch between in one
click, kept in `localStorage`. Each rig tab carries its own median TTFA, so the A/B is on screen
before you click anything.

| View | What it is for |
|---|---|
| **Bench** | Run a rig. The left rail is the chain top to bottom, each leg showing its own latency and whether its key is present, plus the same rig spelled as the `STT=… LLM=… TTS=…` command the scripts take. The centre is the conversation and a per-turn **waterfall** — one bar per turn, split STT · LLM TTFT · TTS TTFB · network — against one scale, so which leg is slow is visible rather than arithmetic. The right rail is the median, the split, and one sentence naming the largest leg. |
| **Compare** | Records off disk, on one axis. Pick runs, pick a metric, and the bars repaint; the leg split is normalised per run so a 600 ms rig and a 2 s rig stay comparable as ratios. |
| **Report** | The bill, with every provenance rule attached to the number it governs, and the per-turn cost projected to a monthly figure at a volume you choose. |
| **Console** | Docked at the bottom, expandable. Filter by level and by source, search, and switch timestamps between wall clock and `t+` from the turn's t0. Metric marks are highlighted and expand to say what they mean. |

A **realtime** run renders as a single band everywhere a pipeline run renders three. That is the
finding, not missing data: a speech-to-speech model has no legs to take apart, so when it is slow the
only dial is the model.

Log-line **sources are guessed**, not reported: the `log` frame carries a level and free text and
nothing else. A line is matched against the vendor names in the active rig's slots, then against
keywords, and an ambiguous one — an all-mock rig, where every slot's vendor token is `mock` — stays
`session` rather than being assigned to whichever slot sorted first. Good enough to filter on, not
something to conclude from; the console says so. Metric marks are the exception: they carry their
leg in the mark name and are read rather than guessed.

Records are written to `backend/data/sessions/<id>.json` **after every turn**, not only at the end, so
a conversation that is never formally ended — closed tab, lost connection, crashed process — still
leaves its token counts on disk. Writes are serialized and atomic (temp file, then rename): two saves
landing in the same tick used to interleave into a file that would not parse, and the damaged record
then vanished from the listing rather than reporting itself.

A record holds no API keys — provider/model ids, the system prompt, and the usage numbers. It does
hold the prompt, deliberately, since that is what produced them. Expect ~1-3 KB per turn, kept
indefinitely; `SESSION_DIR` moves them and `SESSION_MAX_RECORDS` caps them (off by default — silently
deleting a measurement someone is mid-comparison on is worse than the disk use). Past conversations are listed in the UI's Compare view and served from
`GET /api/sessions` and `GET /api/sessions/:id`.

### The conversation is recorded, both directions, in one stereo file

Every conversation **in which the mic is opened** is also recorded to
`backend/data/sessions/<id>.wav`, beside its JSON: **left channel the microphone, right channel
the assistant.** Recording starts when the mic is opened and stops when the conversation ends — turning the mic off and on again mid-call does not
split it, because the unit being recorded is the conversation, not the microphone.

Stereo rather than a mix or two files, because the interesting thing is the timing *between* the
two sides. A barge-in, a late first frame, an assistant still talking over the user — all audible
and measurable in one file, and either channel still solos in any editor. A mix cannot be taken
apart again.

The hard part is the timeline, not the audio. Concatenating chunks as they arrive would give a
file with the right sound and the wrong conversation: every pause squeezed out, so a 40-second
exchange plays back as 12 seconds of back-to-back speech with every latency in it invisible. Each
channel therefore writes each chunk AT A POSITION — `max(head, now)` — so a late chunk leaves a
hole that reads back as the silence it represents. The opposite case is the one that is easy to
get backwards: **TTS arrives faster than real time**, so assistant chunks are routinely "early",
and those go at the head rather than at the clock; padding there would insert silence into the
middle of a spoken word. Positions rather than an append-only stream also mean a gap costs a seek
instead of a multi-megabyte buffer of zeros, and that a head which has run ahead can be clawed
back — which is what barge-in needs, below. `recorder:selftest` covers both directions and every
mutation goes red.

**Barge-in needed its own signal.** A channel's lead is not harmless: TTS renders ~10x faster
than real time, so after one 5-second utterance the assistant channel is ~4.5s ahead of the
clock. If the user then cuts in, the tail was never heard — but it has already been written, and
every later assistant turn is appended after it instead of landing at its own time. One barge-in
turned a 2.7-second conversation into a 7.00-second file with turn two 2500ms late, and the error
never washed out. So `SessionEvents` gained an optional `onInterrupt`, raised by both session
kinds when audio already emitted is cut off; the recorder clamps the assistant head back to the
wall clock and truncates what was never heard. Four checks cover it, and they go red without it.

What the file is: when each side's audio reached the **server** — the same clock the latency
numbers use, which is why the recording and the metrics agree. What it is not: what the user
heard. The browser buffers and plays at real time, so true playback lags this by the jitter
buffer, and the barge-in cut above is therefore very slightly later than the true one. Do not
read inter-channel gaps here as perceived response time.

Recordings are served from `GET /api/sessions/:id/audio` (with `Range` support, so a browser can
seek in a long one) and play inline in the Compare view. `SESSION_AUDIO=0` turns recording off;
`SESSION_AUDIO_MAX_MINUTES` caps it, default 60. The cap matters — stereo PCM16 @ 24 kHz is
**~5.8 MB per recorded minute**, so audio, not JSON, is what fills the disk. Hitting the cap
finalizes the recording rather than discarding it, and `SESSION_MAX_RECORDS` prunes the WAV along
with its JSON.

`summary.latency` carries the **median of every leg**, not just TTFA — `sttMedianMs`,
`llmTtftMedianMs`, `ttsTtfbMedianMs`, `totalTurnMedianMs`, `audioMedianMs`. Those numbers were always
computed and always on the wire; they were simply never kept, so a record could say a conversation was
slow without saying where. Comparing two past runs is arithmetic on exactly those medians. All the
new fields are optional and records written before them are read back as they are — they show a
hatched bar in Compare rather than being discarded.

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

The table below is a **sample, not the file**: `openai-llm` (7 models), `openai-realtime` (2),
`gemini-stt`, `gemini-tts` and `elevenlabs-tts` are priced there too, and are described under
[The five late providers, and what contact with the vendor changed](#the-five-late-providers-and-what-contact-with-the-vendor-changed).

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
cd backend  && npm run turn:selftest             # 36 checks on turn attribution and the TTFA derivation
cd backend  && npm run usage:selftest            # 133 checks on arithmetic, persistence, redaction and per-leg latency medians
cd backend  && npm run catalog:selftest          # 111 checks — every provider/model/language path the UI can click
cd backend  && npm run gemini:selftest           # 37 checks incl. token-usage parsing
cd backend  && npm run murf:selftest             # 40 checks against a local fake
cd backend  && npm run recorder:selftest         # 40 checks on the conversation recorder's timeline, against real files
cd backend  && npm run gemini:speech:selftest    # 80 checks — Gemini TTS + STT against local fakes
cd backend  && npm run elevenlabs:selftest       # 57 checks against a local fake
cd backend  && npm run openai:realtime:selftest  # 130 checks against a local fake
cd backend  && npm run openai:llm:selftest       # 55 checks against a local fake
cd backend  && npm run models                    # 10 checks against the vendors' free model listings (needs a key, bills nothing)
cd backend  && npm run smoke                     # usage + summary over the real WS protocol
cd backend  && npm run realtime:probe            # a realtime turn with real SPEECH in (needs a key, billable)
cd frontend && npm run render-check              # 88 checks: actually renders every panel, and pins the rules
                                                 # (voice resolution, leg overlap, TTFA attribution) that only a call can prove.
                                                 # tsc did not catch this project's last UI crash. Start the backend
                                                 # and it additionally runs against the live 26-provider catalog.
```

719 backend checks plus 91 frontend render checks, none of which needs a key or a network. Read the caveat in
[The five late providers, and what contact with the vendor changed](#the-five-late-providers-and-what-contact-with-the-vendor-changed)
before treating `gemini:speech`, `elevenlabs`, `openai:realtime` or `openai:llm` as evidence of
anything about a vendor — they run against fakes. `models`, `smoke`, `roundtrip` and
`realtime:probe` are the only checks here that touch a real API.

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
npm run gemini:selftest      # 37 checks, no key or network needed
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
cd backend
npm run cartesia          # Sonic -> Ink round trip
npm run cartesia:voices   # regenerate the voice library + measure language support
```

Both legs run natively at **24 kHz pcm_s16le** — the bench's canonical format — so neither
transcodes nor resamples. STT audio goes up as raw binary frames, not base64.

### 934 voices, 44 languages, and a different language set per model

The eight voice ids this file used to list were a rounding error: `GET /voices` returns **934
voices across 44 languages** — 417 English, **49 Hindi**, 10 Tamil, 9 Telugu, and so on down
to one Ukrainian. They are all in the picker now, filed under their language, generated into
`src/providers/cartesia-catalog.ts` by `npm run cartesia:voices`.

Two things that generator establishes which no doc page states:

**Which languages a model takes is per model, and the spread is enormous.** One short live
utterance per model/language pair, 220 of them:

| Model | Languages accepted |
|---|---|
| `sonic-3.6` | **all 44** |
| `sonic-3.5` · `sonic-3` | 42 — everything but Odia and Urdu |
| `sonic-turbo` | 9 — `de en es fr hi ja ko pt zh` |
| `sonic-2` | 8 — the same minus Hindi |

The older models answer an unsupported language with *"The language is not supported by this
model"*, and a few pairings with *"The requested model has been sunsetted"*. Since the catalog
is what the UI renders, those combinations are simply absent from it: pick `sonic-2` and the
language list shortens to eight, taking any voice that no longer fits with it.

**A voice is not bound to the language it is filed under.** An English voice speaking Hindi
is accepted, and so is the reverse (measured). The grouping exists to make 934 options
navigable — the same thing [play.cartesia.ai](https://play.cartesia.ai/voices?language=hi)
does — not to constrain the pairing. To cross it, paste the id into the **Voice id** field,
which Cartesia now also accepts (`acceptsVoiceId`), and which is how a cloned voice gets in.

Verified end to end in Hindi: `Amrit` on `sonic-3.6`, 281ms TTFB, transcribed back by Saaras
at 9/10 words (the difference is a nuqta).

```bash
cd backend
TTS=cartesia-tts TTS_MODEL=sonic-3.6 VOICE=97303aad-1a66-4edf-870a-58e6ba545005 TTS_LANG=hi \
STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' STT_LANG=hi-IN \
  npx tsx scripts/roundtrip.ts "हमारी वापसी अवधि खरीद की तारीख से तीस दिन है।"
```

Because five models share one library, the voices are held once on the provider as
`voicesByLanguage` and the models name only their language codes — nesting them per model
sent the library five times and made `/api/catalog` a 613 KB response instead of 175 KB.

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
Verified end to end against the live API on 2026-09-05 (`murf-tts -> sarvam-stt` round trip,
91% word overlap on both models).

| Model | Host | Measured TTFB | Voices |
|---|---|---|---|
| `falcon-2` | `wss://global.api.murf.ai/v1/speech/stream-input` | **~186ms** (~90ms socket-warm) | 137 |
| `gen2` | `wss://api.murf.ai/v1/speech/stream-input` | ~1.75s | 163 |

Falcon 2 is the fastest TTS in this bench. Gen2 is here for comparison only.

```bash
echo 'MURF_API_KEY=your_key' >> backend/.env
cd backend
npm run murf:selftest   # 40 checks, no key needed — message handling + catalog invariants
npm run murf:probe      # re-measures the request shape and the buffering behaviour
npm run murf:voices     # regenerates src/providers/murf-catalog.ts from the live API
```

Requested as raw `PCM`, `MONO`, 24 kHz — the bench's canonical format, so no resampling.
A RIFF header is stripped if one shows up anyway (`stripWavHeader`, shared with Sarvam).

### The three things the docs get wrong

Every one of these was a live error before it was measured, and each is now a field on
`MurfModelProfile` in `MurfTtsProvider.ts` rather than a constant buried in the socket code.

**1. Each model has its own voice catalogue.** Falcon 2 publishes 137 voices, Gen2 163, and
only 100 are shared. Asking one for the other's voice is a hard failure:

```
Invalid voice_id: en-US-imani. The specified voice is not supported for the
selected model (FALCON). Note: Falcon-2 and Gen2 each have their own voice catalog.
```

So voices and locales hang off the **model** in `catalog.ts`, not off the provider —
`ModelEntry.voices` / `.languages`, read through `voicesFor()` / `languagesFor()`, whose rule
is *a model's own list wins*. Changing the model in the UI re-picks any voice or language the
new model does not offer. The lists themselves are generated: `npm run murf:voices` rewrites
`src/providers/murf-catalog.ts` from `GET /v1/speech/voices?model=FALCON|GEN2`.

**2. Gen2 is not on the global host.** It closes with `1008 Gen2 Model is not available in
global.api.murf.ai`. Each model therefore carries its own `wsBase`. Falcon answers on both
hosts, but the global one is ~3x faster from here, so the profile pins it there.

**3. A voice id has two accepted spellings, and only one of them is checkable.** The API
returns qualified ids — `hi-IN-namrita` — but both endpoints also resolve the bare display
name the docs use, `Namrita` (verified: 3/3 on the websocket, and the documented `curl`
against `POST /v1/speech/stream` returns a real WAV). Resolution is per model either way:
`Imani` and `en-US-imani` are both refused on Falcon because that voice is Gen2's. The
catalog therefore stores the qualified ids — they are what the API publishes and what can be
checked against a model's list — while the **Voice id** field accepts either.

What turned out **not** to matter, measured across all 14 permutations in `murf:probe`: the
`api-key` header and the query param both authenticate, `voiceId` and `voice_id` are both
accepted, and `falcon-2` / `FALCON` / `Falcon` are interchangeable. The three ambiguities
this file used to warn about were never the problem — the voice catalogue was.

### Voices: the dropdown is not the whole list

Beyond the per-model lists, Murf takes cloned and Voice Library ids, so the Murf entry sets
`acceptsVoiceId: true` and the picker grows a **Voice id** field next to the dropdown. A
non-empty id wins over the selection and goes to Murf verbatim. It is one catalog flag — set
it on any other vendor measured to accept an id a dropdown cannot enumerate. Nothing is
validated locally: an id the vendor rejects comes back as its own error rather than as a
silently different voice.

Two rules the provider applies to whatever id it is handed:

- A **locale-prefixed id** is a catalogue voice, so the default `Conversational` style rides
  along. (A style a voice does not list is tolerated — `en-IN-isha` publishes none and
  renders fine — but a voice id from the other model's catalogue is not.)
- Anything else — a bare display name, a cloned or Voice Library voice — cannot be matched to
  a catalogue entry here, so **no style is sent** and Murf applies the voice's own.

### Locales, not languages

Murf names locales: `en-US`, never `en`. Other legs of this bench speak bare ISO codes, and a
bare one is refused — *"Locale 'en' is not a recognized or supported locale for the Falcon
model"*. So the provider widens a bare code to the first locale that model publishes for that
language (`en` → `en-US`, `hi` → `hi-IN`) and drops anything still unrecognised rather than
sending it to be refused; the voice's own locale is the right fallback. A mismatched pairing
is *not* an error — a `hi-IN` voice with `multi_native_locale: en-US` renders — which is what
multinative speech is for.

### Buffering: the Cartesia trap does not apply here

Cartesia's Sonic voiced every token as its own utterance at `max_buffer_delay_ms: 0` — 2.6x
too much audio. Murf, measured against a one-shot reference of the same sentence (3.48s):

| `max_buffer_delay_in_ms` | TTFB | Audio rendered |
|---|---|---|
| one-shot reference | 90ms | 3.48s |
| `0` | 84ms | 3.96s |
| `100` | 83ms | 4.28s |
| `250` | 97ms | 4.28s |
| vendor default | 81ms | 4.28s |

Word-by-word costs 14-23% extra audio at every setting, and `0` is the *closest* to the
reference rather than the worst — Murf aggregates sensibly on its own. TTFB is flat across
the range, so there is nothing to buy by tuning it: the provider leaves the delay at the
vendor default and sets only a small `min_buffer_size`. Re-check with stage 3 of `murf:probe`.

### What the 40 self-test checks do and do not prove

They run the real provider against a local fake speaking Murf's dialect, covering base64
decoding, the `final` flag, `voice_config` ordering, `end` flags, one shared `context_id`,
header-not-URL auth, RIFF stripping, error surfacing, barge-in, text queued before the socket
opens, the per-model wire shape, and the catalog invariants that keep one model's voice off
another. **A fake cannot prove Murf accepts any of it** — that is what `murf:probe` and a real
`roundtrip` are for, and it is the lesson from the Gemini `thinkingLevel` bug: green checks
against my own assumption told me nothing about what the vendor would accept. Here they told
me nothing about the voice catalogue either, which is exactly where the live API bit.

## The five late providers, and what contact with the vendor changed

Gemini TTS, Gemini Transcribe, OpenAI Realtime, OpenAI LLM and ElevenLabs TTS were added on
2026-09-05 and written entirely from documentation. **All five have now completed live calls**,
on the same date. This section is the record of that: what was measured, and what contact with
the real APIs corrected.

Keep the distinction that made this section necessary in the first place. A live round trip
proves the request shape, the auth, the audio format and the decode path. It does **not**
upgrade the self-tests: every provider suite still runs against local fakes written to
agree with our own hypotheses, and a green suite remains worth nothing as vendor evidence. Only
`roundtrip`, `smoke`, `realtime:probe` and `models` touch a vendor.

### What was run, and what came back

| Provider | Live check | Result |
|---|---|---|
| `elevenlabs-tts` | `npm run elevenlabs` (→ `cartesia-stt`) | transcribed back at 91% word overlap; `pcm_24000` served on this account tier |
| `gemini-tts` | `npm run gemini:speech` (→ `gemini-stt`) | 101 SSE frames, 4.0s of audio, transcribed back |
| `gemini-stt` | `roundtrip` from both `elevenlabs-tts` and `gemini-tts` | full transcript, correct at the word level |
| `openai-llm` | `node scripts/smoke.mjs pipeline` | streamed, and reported vendor token counts |
| `openai-realtime` | `smoke.mjs realtime` **and** `npm run realtime:probe` | answered text and speech; billed audio tokens as audio |

### Measured time-to-first-byte

One fixed sentence, warm socket. The **Samples** column is not decoration — these rows are not
all the same kind of number, and averaging them in your head would be wrong. Only the first three
are medians of a repeated run; the realtime and STT rows are single observations and should be
read as "about this", not as a characteristic of the model.

| Leg | Model | TTFB | Samples | Read it as |
|---|---|---|---|---|
| `elevenlabs-tts` | `eleven_flash_v2_5` | **426ms** | median of 3 | one-shot text; 837ms streaming word-by-word |
| `elevenlabs-tts` | `eleven_multilingual_v2` | 717ms | median of 3 | one-shot text |
| `gemini-tts` | `gemini-3.1-flash-tts-preview` | 1798ms | median of 3 | streaming SSE, but see the caveat below |
| `gemini-tts` | `gemini-2.5-flash-preview-tts` | ~4871ms | 2 runs | one-shot `:generateContent` — whole-generation time, **not** a TTFB |
| `openai-realtime` | `gpt-realtime-2.1` | 955ms | 1 run | first audio after commit, real speech in |
| `openai-realtime` | `gpt-realtime-2.1-mini` | 976ms | 1 run | first audio after commit, text in |
| `gemini-stt` | `gemini-3.5-transcribe-live` | ~365ms | 1 run | final transcript after the local VAD called t0 (first partial ~1.0s) |

`gemini-2.5-flash-preview-tts` is the clearest case of a number that must not be read as a TTFB.
It is served by `:generateContent`, which returns one complete body, so the ~4.9s *is* the
generation. Only `gemini-3.1-flash-tts-preview` streams.

### A bug that only a live call could have found

The `gemini-stt` socket closed **1006, mid-turn, twice**, after several good partials. The
provider reported the error and emitted no final — which above the provider layer is not an
error but a **hang**, `PipelineSession` blocked forever on an `onFinal` that would never come,
with the banked transcript discarded.

The close handler now salvages: an abnormal close emits whatever transcript is banked, then
reports the error. `emitFinal` is idempotent, so a turn that already finalized emits nothing
twice, and a deliberate `close()` never takes this path. Four checks in
`gemini:speech:selftest` cover it, and they go red against the old handler.

The 1006 itself was **not** reproduced on demand: 6/6 idle sessions survived 15s, one survived
120s, and every subsequent round trip succeeded. Both occurrences were minutes after the account
was topped up. It is recorded here as rare and unexplained, not as a characterised failure mode
— the fix is about not losing a turn when it happens, not about knowing why it does.

### The Gemini Live API transcription wire, as actually observed

Worth writing down because the docs describe none of it precisely, and one field is the whole
turn boundary:

```
<< {"setupComplete":{}}
<< {"serverContent":{},"voiceActivity":{"type":"ACTIVITY_START","audioOffset":"0.200s"}}
<< {"serverContent":{"interimInputTranscription":{"text":"Our refund window is"}}}   <- partial
>> {"realtimeInput":{"audioStreamEnd":true}}                                          <- local VAD
<< {"serverContent":{"inputTranscription":{"text":"...date of purchase."}}}           <- FINAL
<< {"serverContent":{"generationComplete":true}}                                      <- boundary
<< {"serverContent":{},"voiceActivity":{"type":"ACTIVITY_END","audioOffset":"3.297s"}}
```

- `interimInputTranscription` and `inputTranscription` are **different fields**, not the same
  field with a flag. The first is speculative and rewritten; the second is a finalized segment.
- **`turnComplete` was never observed.** `generationComplete` is what actually ends the turn.
  The provider accepts either, which is the only reason this worked first time.
- `VoiceActivity` — undocumented when this was written — turns out to carry
  `{type: ACTIVITY_START|ACTIVITY_END, audioOffset}`. It arrives *after* the final transcript,
  so it is still no use as t0, and the local VAD stays.
- The final transcript lands ~350-560ms after `audioStreamEnd`.
- Audio sent *after* `audioStreamEnd` is accepted, and in a controlled A/B the run that kept
  streaming trailing silence got a complete final transcript while the run that stopped
  immediately got only a truncated interim. The provider does not stop pushing audio at
  finalization, and on this evidence it should not start.

### One inference that looked measured and was not

`ListModels` reports no `streamGenerateContent` for any Gemini TTS model, which reads like
proof that Gemini TTS cannot stream. It is not — that field never lists
`streamGenerateContent` for *any* model, including ones that certainly stream. Google's
changelog says the opposite outright: streaming speech generation is supported, on
`gemini-3.1-flash-tts-preview` and only there. Absence from that list is not evidence of
absence, and the catalog now follows the changelog rather than the inference.

### Gemini TTS is the odd one out, and its TTFB is not comparable

Gemini TTS **cannot accept incremental text**. The request carries one complete body;
`stream: true` streams audio *out*, never text *in*, and the TTS model pages list "Live API:
not supported", so there is no socket to feed either. `GeminiTtsProvider` therefore
accumulates on `pushText` and issues a single request on `flush()`.

The consequence matters more than the mechanism: **its time-to-first-byte includes the entire
LLM generation**, because nothing can be sent until the LLM is finished. Cartesia's ~174ms and
Murf's ~186ms are time to the first frame of a stream that started while the model was still
writing. Putting Gemini's number in the same column would be comparing two different quantities.
Read it as end-of-LLM → first-audio.

Only `gemini-3.1-flash-tts-preview` streams the audio back, which is the one thing keeping its
first-frame number meaningful at all; the two 2.5-series models return the whole utterance in a
single response and are deprecated in Google's own favour of the 3.1 model.

### Gemini publishes no speech-end event, so t0 comes from the local VAD

t0 for every latency number in this bench is the moment the user stopped speaking. Gemini's
Live API has no speech-end event — `speechState` is deprecated in favour of a `VoiceActivity`
message whose definition Google has not published, and the only documented turn boundary is the
*arrival* of a finalized transcript, which lands after the server's silence timer has already
expired. Using that as t0 would fold the vendor's endpointing delay into every measurement and
make Gemini look faster than it is.

So `GeminiSttProvider` uses the same local `SpeechEndDetector` as Cartesia, and sends
`audioStreamEnd` immediately — which Google's docs describe as bypassing the server-side silence
wait. Same t0 definition as every other provider, different detector. That is the rule, not an
exception to it.

### OpenAI Realtime: the docs and the schema disagree, and the schema wins

The prose guides still show the flat session shape (`input_audio_format`, `output_audio_format`,
`turn_detection` at the top of `session`). OpenAI's published API schema shows the GA object is
nested — `session.audio.input.format`, `session.audio.output.voice` — with a required
`type: "realtime"`. The provider follows the schema; the flat shape is the stale half.

Two things fall out of that schema that are unusually convenient here:

- The audio format object's own docstrings read *"The audio format. Always `audio/pcm`"* and
  *"The sample rate of the audio. Always `24000`"*. 24 kHz PCM16 mono is exactly
  `CANONICAL_SAMPLE_RATE`, so this is the one vendor leg in the bench that needs no resampling
  in either direction.
- `turn_detection` offers `server_vad` and `semantic_vad`. `server_vad` is what maps onto this
  bench's `t0`, since `input_audio_buffer.speech_stopped` is a speech-end event of exactly the
  kind Gemini lacks.

### Realtime billing needed a new shape in the ledger

OpenAI's realtime models publish **two token prices in one request** — on `gpt-realtime-2.1`,
audio is $32/$64 per 1M in/out while text is $4/$24. A single `input`/`output` pair cannot say
that, and a realtime turn is almost entirely audio tokens, so pricing one at the text rate would
understate it ~8x *while still looking like a plausible number*.

`LegUsage` therefore carries `audioInputTokens`, `audioOutputTokens` and
`cachedAudioInputTokens`, each obeying the same containment rule as the existing breakdown
fields — a total always includes its parts — and `Rate` carries `audioInput` / `audioOutput` /
`cachedAudioInput`. `priceLeg` splits the leg and bills each half at its own rate.

The guard matters as much as the arithmetic: **a leg reporting audio tokens against a rate that
has only one token price is left unpriced**, with a reason saying so, rather than billed at the
text rate. Silence beats a wrong number that looks right.

### ElevenLabs: the buffering knobs are pointed at quality, not latency

ElevenLabs exposes `chunk_length_schedule` and `auto_mode`, the same class of control as
Cartesia's `max_buffer_delay_ms` — and this pipeline streams raw LLM tokens with no sentence
aggregation upstream, which is precisely the condition under which Cartesia at `0` voiced every
token as its own utterance and rendered 2.6x too much audio.

That question has now been **measured**, and the probe is committed —
`npm run elevenlabs:buffer` re-runs it. Same method used on Cartesia and Murf: a fixed
140-character text synthesised one-shot for a reference (8.08s), then streamed word by word at
~40ms/word under each setting, comparing rendered audio duration rather than TTFB. Median of
three trials each.

| Setting | TTFB | Rendered | Verdict |
|---|---|---|---|
| `auto_mode: true` | 465ms | **13.89s = 172%** | the Cartesia fault, on this vendor |
| `[120,160,250,290]` (vendor default) | 1298ms | 7.85s = 97% | safe, slow |
| `[50,160,250,290]` **shipped** | **837ms** | 7.89s = 98% | safe, and ~460ms faster |
| `[50,120,160,250]` | 859ms | 7.99s = 99% | safe; the later steps buy almost nothing |
| `[20,50,120,160]` | — | — | refused: `invalid_generation_config` |

Two findings, both load-bearing:

1. **`auto_mode: true` really is the Cartesia trap.** 178% of the reference duration is the
   signature of text fragmented into separately voiced utterances. The vendor's warning about
   partial sentences is accurate, and this pipeline is exactly the case it warns about. The
   provider sends `false`, and that is now a measurement rather than a precaution.
2. **Shortening the first step does not reproduce the fault.** Every accepted schedule rendered
   within 97-99% of the one-shot reference, and of each other, while the first step alone moved
   TTFB by ~460ms. 50 is the floor; 20 is refused outright.

So the schedule now opens at `[50,160,250,290]` and the later steps keep the vendor's values.
What this does **not** establish: rendered duration catches word-isolation, the gross fault, and
nothing subtler. Nobody has listened to these samples side by side, and the vendor still claims
longer inputs read better. If ElevenLabs prosody is ever suspect, restore `120` as the first
step before looking anywhere else.

### Two vendor facts that outrank the docs

**ElevenLabs bills the API in dollars per character, not in credits.** The credit pool is the
subscription product and a separate billing system; pricing this leg off credits overstates it
about 3x. Flash and Turbo are $0.05 per 1K characters, `eleven_multilingual_v2` $0.10. An
unlisted model falls back to the expensive tier, because for an unchecked number an
overestimate is the safer direction. A promotional banner offering 50% off API pricing *for
life* was live on 2026-09-05; an account that took it pays half these rates.

**ElevenLabs' default voices are on a hard sunset.** The help centre states all default voices
expire **2026-12-31** and are *already* unavailable on accounts created after March 2026. The
three ids in the catalog — George, Rachel, Sarah — are therefore expected to fail outright on a
new account, and the free-text voice id field is the working path rather than a convenience.
The replacement voices are named in the docs but their ids are not published, so the real fix is
a generated catalog from `GET /v2/voices`, exactly as `murf-voices.ts` and `cartesia-voices.ts`
already do. This vendor is a stronger case for generation than either of those, because its ids
have a published expiry date.

`eleven_turbo_v2_5` is kept only for comparison and labelled deprecated — the vendor's own
wording is to use Flash over Turbo "in all use cases". `eleven_v3` is absent because the docs list it as
excluded from this socket (v3 dialogue has its own endpoint) — documented, not observed. `eleven_v3_conversational` is absent on the weaker
ground that only `eleven_v3` is *explicitly* excluded — it may well work here, and it is the one
model that would give this bench a mid-latency multilingual option, so it is the first thing
worth probing.

### Known undercounts, stated rather than hidden

- **OpenAI Realtime** enables input transcription (the speech-to-speech model emits no user
  transcript of its own, so the transcript panel would otherwise be empty). That ASR runs on a
  separate model billed **per minute**, which the realtime leg does not meter. A realtime total
  is a floor by that add-on.
- **Gemini bills STT in tokens**, not seconds — an exception to this bench's "STT in seconds of
  audio" convention. The rate on file is Google's own blended per-minute figure, flagged
  `ambiguous` because a blended rate averages over an assumed transcript length. Google's Live
  API *does* report `usageMetadata` broken down by modality, but `SttEvents` has no `onUsage`
  channel to carry it — only the LLM slot does — so the leg is counted locally and marked `local`
  rather than `vendor`. That is a real vendor count left on the table, not an estimate that could
  not be improved; closing it means widening the STT interface, which no other vendor here needs.
- **The GPT-5.6 family bills cache writes** as a separate line the API does not report, so it
  cannot be priced here. `gpt-5.6-sol` is also on promotional pricing through at least
  2026-11-21, with no published post-promo number to step to.

### How to re-verify these

Every command below has been run against the live vendor on 2026-09-05. Re-run them after any
change to a request shape:

```bash
cd backend
npm run gemini:speech      # Gemini TTS -> Gemini Transcribe round trip
npm run elevenlabs         # ElevenLabs TTS -> Cartesia Ink round trip

# any pairing works; mix vendors to isolate a bad leg
TTS=gemini-tts TTS_MODEL=gemini-3.1-flash-tts-preview VOICE=Kore TTS_LANG=en-US \
STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' STT_LANG=en-IN \
  npx tsx scripts/roundtrip.ts "Our refund window is thirty days from the date of purchase."

# the OpenAI LLM leg, through the full protocol (needs npm run dev)
STT=mock-stt LLM=openai-llm LLM_MODEL='gpt-5.6-luna@none' TTS=mock-tts \
  node scripts/smoke.mjs pipeline
```

```bash
# the realtime leg with real SPEECH in, which smoke.mjs cannot do (it sends text,
# so it never bills a single audio input token)
npm run realtime:probe
```

`npm run realtime:probe` is the only check that exercises the audio-in half of a speech-to-speech turn,
and therefore the only one that can tell whether `audioInputTokens` is reported at all. It
asserts the audio breakdown is non-zero, is contained by its total, and prices — a realtime leg
billed entirely at the text rate would understate the turn ~8x while still looking like a number.

Everything in this section is measured. The self-tests still are not: they run against local
fakes, and per the claim-discipline rule a green suite may never be restated as vendor evidence.

## Adding a provider

Two steps. Nothing else in the app changes.

**1. Flip it on in the catalog** — `backend/src/providers/catalog.ts` already lists 26 providers with
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
