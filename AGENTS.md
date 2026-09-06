# AGENTS.md

Instructions for Cursor agents working in this repository. `CLAUDE.md` is the
longer sibling with the same invariants; `README.md` is the record of what live
vendor APIs actually accept. Do not copy claims from either into a catalog
comment or commit message without following claim discipline below.

A harness for A/B-testing voice AI providers on latency and audio quality across
two architectures — **realtime** (one native speech-to-speech model) and
**pipeline** (STT → LLM → TTS) — behind one `VoiceSession` interface so the
numbers are comparable.

`backend/` and `frontend/` are two independent npm projects. There is no
workspace root; the root `package-lock.json` is empty. Install and typecheck
each tree separately.

## Cursor Cloud specific instructions

Cloud agents run on a fresh Ubuntu VM. This repo does not commit `node_modules`
or `.env`.

```bash
cd backend  && npm install && cp -n .env.example .env
cd frontend && npm install
```

`-n` leaves an existing `.env` alone. Mock providers are registered permanently,
so the app and the no-key selftests run with empty vendor keys. Do not invent
keys. Live probes (`roundtrip`, `realtime:probe`, `models`, `murf:probe`,
`cartesia:voices`, `gemini:live`, `elevenlabs:buffer`) need the matching secret
from the environment; skip them when the key is absent rather than stubbing a
fake as a live result.

Dev servers (start only when you need them; they are not required for
typecheck or selftests):

```bash
cd backend  && npm run dev    # :8787  — Express + WS
cd frontend && npm run dev    # :5173  — Vite, proxies /api and /ws to :8787
```

`npm run smoke` needs the backend already listening. `frontend` `render-check`
runs offline against fixtures; when the backend is up it also hits
`GET /api/catalog` and seeds a rig from every provider.

There is no linter and no unit-test runner. Verification is typecheck plus the
scripts in the tables below. Browser UI changes still need `render-check`;
`tsc` passing is not evidence that a component renders.

## Commands

```bash
cd backend  && npm run typecheck        # tsc --noEmit over src/ and scripts/
cd frontend && npm run typecheck
cd frontend && npm run render-check     # SSR-renders every panel
cd frontend && npm run sync-protocol    # copy backend protocol.ts → frontend
```

### Backend verification (no API key)

| Command | What it proves |
|---|---|
| `npm run smoke` | one full turn over the real WS protocol, both modes (needs `npm run dev`) |
| `npm run gemini:selftest` | Gemini SSE/wire handling against a local fake |
| `npm run usage:selftest` | cost arithmetic, persistence, secret redaction |
| `npm run turn:selftest` | turn attribution: silence, barge-in, overlapping turns, TTS failure, tails |
| `npm run catalog:selftest` | every UI-clickable provider/model/language path resolves |
| `npm run murf:selftest` | Murf message handling against a local fake |
| `npm run recorder:selftest` | conversation recorder timeline — writes files, reads bytes back |
| `npm run gemini:speech:selftest` | Gemini TTS + Transcribe against local fakes |
| `npm run elevenlabs:selftest` | ElevenLabs message handling against a local fake |
| `npm run openai:realtime:selftest` | OpenAI Realtime event handling against a local fake |
| `npm run openai:llm:selftest` | OpenAI Responses SSE + usage parsing against a local fake |

A green selftest is **not** vendor evidence. Those scripts talk to a local fake
that agrees with our hypotheses by construction. Live checks are `roundtrip`,
`smoke` against a real provider, `realtime:probe`, and `models`.

### Backend probes (need a key)

| Command | What it proves |
|---|---|
| `npm run models` | Google/OpenAI listing endpoints vs every catalog id (free, bills nothing) |
| `npm run roundtrip` | any TTS → STT pair: synthesise, stream back at real time |
| `npm run realtime:probe` | realtime turn driven by real speech; asserts audio tokens billed as audio |
| `npm run sarvam` / `npm run cartesia` / `npm run elevenlabs` / `npm run gemini:speech` | preset `roundtrip` invocations |
| `npm run gemini:live [model\|all]` | real TTFT per catalog model variant |
| `npm run murf:probe` / `npm run murf:voices` | re-measure Murf request shape + buffering / regenerate per-model voices |
| `npm run cartesia:voices` | regenerate Cartesia's voice library and per-model language sets |
| `npm run elevenlabs:buffer` | re-measure rendered audio duration per `chunk_length_schedule` / `auto_mode` |

Scripts take **env vars, not flags**: `TTS`, `TTS_MODEL`, `STT`, `STT_MODEL`,
`LLM`, `LLM_MODEL`, `REALTIME`, `REALTIME_MODEL`, `VOICE`, `LANG_CODE`,
`STT_LANG`, `TTS_LANG`, `SYSTEM` (system prompt), `PROMPT` (the turn to say).
The mode is `argv[2]`, not an env var. `LANG` is the shell locale — `smoke.mjs`
ignores it when it looks like one.

These names are a contract with the UI. `envCommandOf` in
`frontend/src/lib/rigs.ts` is pinned to them by `render-check`. A wrong name
does not error; it silently falls back to a mock provider.

```bash
cd backend
TTS=cartesia-tts TTS_MODEL=sonic-3.6 STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' \
  npx tsx scripts/roundtrip.ts "text to say" en

STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' LLM=google-llm \
LLM_MODEL='gemini-3.1-flash-lite@minimal' TTS=sarvam-tts TTS_MODEL=bulbul:v3 \
  node scripts/smoke.mjs pipeline
```

`smoke.mjs` refuses a real provider given without its `*_MODEL` (it would
silently inherit a mock model id).

## Architecture

Two session kinds, one interface. `VoiceSession` (`backend/src/providers/types.ts`)
is implemented by both a native realtime provider and by `PipelineSession`.
Everything above it — `session-socket.ts`, the metrics, the frontend — is
identical for both. Architecture-specific code belongs inside a provider module.

Flow: browser `MicRecorder` → WS binary frames → `handleSocket` →
`createSession()` → `PipelineSession` (or a realtime provider) → audio back as
binary frames → `AudioSink`.

| Path | Role |
|---|---|
| `backend/src/shared/protocol.ts` | wire contract + `CANONICAL_SAMPLE_RATE`. Mirrored by copy to `frontend/src/lib/protocol.ts`. After editing it: `cd frontend && npm run sync-protocol`. Never hand-edit the frontend copy. |
| `backend/src/providers/catalog.ts` | single source of truth for UI toggles. Read voices/languages only through `voicesFor(provider, model, language)` and `languagesFor(provider, model)` — never `entry.voices` directly. |
| `backend/src/providers/murf-catalog.ts` / `cartesia-catalog.ts` | generated. Do not hand-edit. Regenerate with `murf:voices` / `cartesia:voices`. |
| `backend/src/providers/factory.ts` | only session entry point. Validates provider id, model id, and env vars before constructing. |
| `backend/src/pipeline/PipelineSession.ts` | turn assembly, history, barge-in, metric marks. |
| `backend/src/metrics/TurnMetrics.ts` | one per turn; first occurrence of a mark wins. |
| `backend/src/pricing/rates.ts` | vendor rates with source URL, date read, `confidence`. |
| `backend/src/pricing/UsageLedger.ts` | prices each turn as it lands; session total is the sum of per-turn rows. |
| `backend/src/store/SessionStore.ts` | one JSON file per conversation under `data/sessions`. |
| `frontend/src/lib/rigs.ts` | named provider combinations; `envCommandOf` is the script-contract. |
| `frontend/scripts/render-check.tsx` | SSR harness for every panel. Extend it when a component or `StartConfig` / `Rig` / `SessionSummary` changes shape. |

## Invariants (do not violate)

- **Audio is PCM16 LE mono @ 24 kHz** (`CANONICAL_SAMPLE_RATE`) at every session
  boundary, both directions. A vendor that wants 16 kHz or µ-law is adapted
  *inside its own module* via `resamplePcm16()`, against `opts.sampleRate`, not
  the constant.
- **t0 is `user_speech_end`**, set by `beginTurn()`. Vendor VAD or local
  `SpeechEndDetector` — same definition, different detector. Do not move t0.
- **Providers read keys from `ctx.credentials` / `opts.credentials`, never
  `process.env`.** Process-level exceptions: `config.ts`, `factory.ts` and
  `catalog.ts` (readiness), `pricing/rates.ts`, `store/SessionStore.ts`.
- **Vendor connection setup is inside the measured window.** `tts_request_sent`
  is marked before `tts.open()`. Do not pre-connect to flatter TTFB.
- **Stream, don't buffer.** First TTS frame out as soon as it exists.
  `cancel()` / `abort()` must be immediate — barge-in depends on it.
- **Catalog entries are measured, not assumed.** Unsupported model/setting
  pairings are absent so the UI cannot produce a 400. `acceptsVoiceId: true`
  only where the vendor was measured to take an id the dropdown cannot enumerate.
- **Usage is in the unit the vendor bills in** — STT seconds, LLM tokens, TTS
  characters. Do not flatten them into one "token" number. `LegUsage.source` is
  `'vendor' | 'local'`; a local estimate is never rendered as a measurement.
- **A missing rate is unpriced, never zero.** Session total is then a floor.
  Providers report counts and never learn what anything is worth.
- **Audio tokens vs text tokens.** A speech-to-speech vendor that bills them
  differently gets both rates. A leg reporting audio tokens against a
  single-price rate is left unpriced — billing it at the text rate understates
  a realtime turn ~8×.
- **A turn is billed only once it runs.** Pending turns that never run
  (silence, false endpoint, interrupt) are *abandoned* and hand banked STT
  audio back. Billing a pending turn invents turns; stranding one freezes t0.
- **Do not lower TTS text-aggregation knobs to chase TTFB** without measuring
  rendered audio duration against a one-shot reference. Cartesia at `0` voiced
  every token as its own utterance (2.6× audio). Cartesia stays at `250ms`.
- **Errors reaching the browser are scrubbed** (`redactSecrets`). Session
  records hold no credentials; they do hold the system prompt. Treat
  `data/sessions/` as conversation content.
- Mock providers stay registered. Swap one leg to mock to isolate a fault.

Reasoning depth is encoded in the model id as `@variant`
(`gemini-3.8-flash@off`) and split by the provider. `catalog.ts` lists only
verified combinations.

## Skills — read before the matching work

| When | Read |
|---|---|
| Any sentence about what a vendor accepts or rejects (README, catalog comment, provider header, commit message) | `.claude/skills/claim-discipline/SKILL.md` |
| Adding or un-stubbing a provider (`implemented: true`, new module, factory registration) | `.claude/skills/add-provider/SKILL.md` |
| Adding/editing a component under `frontend/src/components`, or changing `StartConfig` / `Rig` / `SessionSummary` | `.claude/agents/ui-render-guard.md`, then extend and run `render-check` |

A capability claim ships only with a committed probe behind it, re-run at the
moment you write it. Negative claims need it most. Green selftests against a
fake you wrote prove nothing about the vendor.

## Adding a provider (skeleton)

Full checklist is the add-provider skill. The four steps:

1. `implemented: true` on the `catalog.ts` entry with correct `envKeys`.
2. Implement the slot from `types.ts`; `registerX(new XProvider())` in `factory.ts`.
   Mocks are the reference implementations.
3. Add a rate in `pricing/rates.ts` (source URL, date read, `confidence`). Skipping
   this is allowed — the leg reports unpriced, not free.
4. If the vendor returns token counts, call `events.onUsage()`. Otherwise
   `PipelineSession` estimates and flags the row `local`.

Nothing else changes — the frontend renders from the catalog.

A provider is not done when it compiles. It is done when a live round trip
passes and the numbers are in the README.

## UI work

Type-checking a component is not evidence that it renders. After changing a
panel or a shape it renders from:

```bash
cd frontend && npm run typecheck && npm run render-check
```

Cover the default state, the empty state, the state the change introduced (and
its negative), and degraded session records (must never print `NaN`). Catalog
fixtures must match live `/api/catalog` — voices hoisted to `voicesByLanguage`
on the provider.

When browser tools are available, exercise the changed flow end to end (click,
type, connect), not only a screenshot.

## Generated and copied files

Do not hand-edit:

- `backend/src/providers/murf-catalog.ts` — `npm run murf:voices`
- `backend/src/providers/cartesia-catalog.ts` — `npm run cartesia:voices`
- `frontend/src/lib/protocol.ts` — `cd frontend && npm run sync-protocol`

## Secrets

Key names live in `backend/.env.example`. Values never belong in source,
`AGENTS.md`, logs, or client-visible errors. `credentials()` hands every
provider the whole environment, so interpolating options into an error message
would leak every key to the browser — that is why `redactSecrets` exists.
