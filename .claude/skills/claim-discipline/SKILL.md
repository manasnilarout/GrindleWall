---
name: claim-discipline
description: The evidence rule for this repo's vendor claims. Use before writing any statement about what a vendor's API does or does not accept into README.md, CLAUDE.md, a catalog comment, a provider header, or a commit message — especially a negative one ("not supported", "rejected", "the docs are wrong"). Also use when about to generalise a finding from one endpoint, model or account to another.
---

# Claim discipline

`README.md` is "the record of what the live APIs actually accept". That makes every sentence
in it a claim someone will later act on without re-checking. This repo has already been
burned twice — once by trusting a fake, once by trusting me.

## The rule

**A capability claim ships only with a reproducible probe behind it, re-run at the moment you
write it.** Negative claims need it most: "X works" fails loudly the next time someone tries
X, while "X is not supported" quietly removes an option forever.

## Before writing the claim

1. **Name the surface.** Which endpoint, which model, which host, which account. A finding on
   `POST /v1/speech/stream` says nothing about `wss://…/stream-input`. If you cannot name it,
   you are not ready to write it.
2. **Reproduce it now.** Not "it failed earlier" — run it. For a negative claim run it at
   least three times; vendors have transient failures and they surface as whatever the
   resolver last touched.
3. **Commit the probe.** A throwaway script that proved something belongs in
   `backend/scripts/` as a named, re-runnable command (`murf:probe`, `cartesia:voices`,
   `gemini:live`), not deleted after use. The next person's question is always "is that still
   true?", and the answer should be one command.
4. **Quote the vendor verbatim.** Their error text is evidence; your paraphrase is not.
5. **Date it.** "Measured on 2026-09-05 via `npm run cartesia:voices`." An undated measurement
   rots invisibly.

## When you cannot reproduce it

Say so, in those words, and stop. Do not reach for a cause. "I cannot reproduce this; the
only reproducible source of that error is X, and this is not X" is a complete and honest
finding. Leave the defensive code in place and say why it is there.

## Two worked examples from this repo

**The Gemini `thinkingLevel` bug.** 25 green self-test checks against a fake I wrote told me
nothing about what Google would accept. Support for reasoning depth turned out to be
per-model and to contradict the docs. This is why `catalog.ts` lists only verified pairings
and why every self-test header states what a fake cannot prove.

**Murf's "Namrita".** I wrote into the README that the docs' `voiceId: "Namrita"` was not a
valid streaming voice id. It is: it is the display name of `hi-IN-namrita`, both endpoints
resolve it, and the documented `curl` returns a real WAV. I had generalised one endpoint's
error to another endpoint I had not tested, and asserted it as a measured finding. The
reproducible fact underneath — that each Murf model has its own voice catalogue, and the
other model's voice is refused — was the real result, and it survived because it *was*
probed. The rest had to be retracted.

## Checklist

- [ ] The claim names its endpoint/model/host, and does not generalise past it.
- [ ] I ran it just now (3x if the claim is negative).
- [ ] The probe is a committed, named script — not scrollback.
- [ ] The vendor's own words are quoted.
- [ ] The date and the command are in the text.
- [ ] Anything I could not reproduce is written as "cannot reproduce", not explained away.
