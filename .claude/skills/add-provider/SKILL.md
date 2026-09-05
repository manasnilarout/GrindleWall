---
name: add-provider
description: Wire a new voice provider (realtime, STT, LLM or TTS) into this bench end to end — catalog entry, slot implementation, factory registration, rates, self-test against a local fake, and the live proof that the vendor actually accepts the request. Use when adding or un-stubbing any vendor in backend/src/providers, when flipping `implemented: true` on a catalog entry, or when a provider exists but has never run against the live API.
---

# Adding a provider

The four steps in CLAUDE.md are the skeleton. What follows is what those steps cost in
practice, learned from Sarvam, Gemini, Cartesia and Murf.

**A provider is not done when it compiles. It is done when a live round trip passes and the
numbers are in the README.** Every vendor so far has disagreed with its own documentation
about something.

## 1. Read the slot interface first

`backend/src/providers/types.ts` defines `RealtimeProvider`, `SttProvider`, `LlmProvider`,
`TtsProvider`. The mock implementations are the reference — they exercise every callback:

    backend/src/providers/tts/MockTtsProvider.ts
    backend/src/providers/stt/MockSttProvider.ts
    backend/src/providers/llm/MockLlmProvider.ts

Read the nearest real sibling too. A new WebSocket TTS should start from
`CartesiaTtsProvider` or `MurfTtsProvider`, not from scratch.

## 2. Catalog entry — measured, not assumed

`backend/src/providers/catalog.ts` is what the UI renders. An entry that lists a combination
the vendor refuses is a 400 the user cannot explain, so **absent beats optimistic**.

- `implemented: true`, correct `envKeys` (readiness is computed from them).
- Models: only ids confirmed to exist. Put measured numbers in `note` — TTFB/TTFT, language
  counts — so the catalog doubles as a latency cheat sheet.
- Voices and languages **narrow provider → model → language**. Read them only through
  `voicesFor(provider, model, language)` / `languagesFor(provider, model)`; never touch
  `entry.voices` directly. Vendors really do differ at each step:
  - per **model** voice catalogues — Murf rejects a Falcon voice on Gen2;
  - per **model** language sets — Cartesia takes 44 languages on `sonic-3.6`, 8 on `sonic-2`;
  - voices filed per **language** — Cartesia's 934 across 44.
- A library of more than a few dozen voices belongs in a **generated module**
  (`murf-catalog.ts`, `cartesia-catalog.ts`) written by a script, never hand-typed. If several
  models share one library, hang it off the provider as `voicesByLanguage` so `/api/catalog`
  carries it once — nesting Cartesia's per model made the response 613 KB instead of 175 KB.
- `acceptsVoiceId: true` **only** where the vendor was measured to take an id the dropdown
  cannot enumerate, and always with a `voiceIdHint` saying where a valid one comes from.

## 3. Implement the module — the invariants are not negotiable

- **PCM16 LE mono @ 24 kHz at the session boundary**, both directions. Adapt inside the
  module with `resamplePcm16()`, against `opts.sampleRate` — not the constant — so the
  provider stays correct if the boundary is ever reconfigured.
- **Credentials come from `ctx.credentials` / `opts.credentials`, never `process.env`.**
- **Connection setup is inside the measured window.** `open()` resolves immediately and
  queues text until the socket is up. Do not pre-connect to flatter the numbers.
- **Stream, don't buffer.** First frame out as soon as it exists; `cancel()` / `abort()`
  immediate, because barge-in depends on it.
- Make the endpoint overridable from credentials (`MURF_WS_BASE` is the pattern) so the
  self-test can point the provider at a local fake.
- Per-model differences — host, request key, default voice, accepted fields — belong in one
  profile table (`MurfModelProfile`), not scattered through the socket handler.
- Text-aggregation knobs (`max_buffer_delay_ms`, `min_buffer_size`) are an **audio quality**
  control, not a latency dial. Cartesia at `0` voiced every token separately: 2.6x the audio.
  Never set one without measuring rendered duration against a one-shot reference.
- Reasoning depth rides in the model id as `@variant` and is split by the provider.

## 4. Register it

`registerX(new XProvider())` in `backend/src/providers/factory.ts`. That file validates
provider id, model id and env vars before constructing anything; nothing else changes.

## 5. Price it

`backend/src/pricing/rates.ts`, with the source URL, the date you read it, and a `confidence`
flag. Skipping this is allowed — the leg reports as **unpriced** and the session total is
labelled a floor. Never let a missing rate become a zero. If the vendor's API reports usage,
call `events.onUsage()` (see `GeminiLlmProvider`); otherwise `PipelineSession` estimates and
flags the row `local`.

## 6. Self-test against a local fake

Copy the shape of `backend/scripts/murf-selftest.ts`: a `WebSocketServer` on port 0, a
swappable `handler`, a `check(name, ok, detail)` list. Cover framing, decoding, the terminal
flag, error surfacing, barge-in, and text pushed before the socket opens.

**Say plainly in the file's header that this proves nothing about what the vendor accepts.**
A fake you wrote will accept whatever you send. Murf's 27 checks were green for weeks while
the provider had never once connected.

## 7. Prove it live — this is the step that finds the real bugs

    cd backend
    TTS=<id> TTS_MODEL=<model> VOICE=<id> TTS_LANG=<lang> \
    STT=sarvam-stt STT_MODEL='saaras:v3-realtime@fast' STT_LANG=en-IN \
      npx tsx scripts/roundtrip.ts "Our refund window is thirty days from the date of purchase."

Then the full protocol, with `npm run dev` running:

    STT=... STT_MODEL=... LLM=google-llm LLM_MODEL='gemini-3.1-flash-lite@minimal' \
    TTS=<id> TTS_MODEL=<model> node scripts/smoke.mjs pipeline

Swap a leg to a mock to find out which leg is at fault. Mock providers stay registered
permanently for exactly this.

## 8. Verify everything

    cd backend  && npm run typecheck && npm run catalog:selftest && npm run turn:selftest \
                && npm run usage:selftest && npm run gemini:selftest && npm run murf:selftest
    cd frontend && npm run typecheck && npm run render-check && npm run build

`catalog:selftest` walks every provider/model/language path the UI can click. `tsc` is not
evidence that a component renders — that is what `render-check` is for.

## 9. Write it down

`README.md` is the record of what the live APIs actually accept: endpoint table, measured
TTFB, what the docs got wrong, and what remains unverified. Update the self-test counts you
changed. If you learned something that constrains future work, it belongs in `CLAUDE.md`.

Before writing any capability claim into those files, follow the **claim-discipline** skill.
