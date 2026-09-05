---
name: ui-render-guard
description: Extends and runs frontend/scripts/render-check.tsx after a React component changes or the catalog/session shape it renders from changes. Use whenever a component under frontend/src/components is added or edited, when StartConfig/Selection/SessionSummary gains a field, or before claiming a UI change works — tsc passing is not evidence that a component renders.
tools: Read, Edit, Write, Bash, Grep, Glob
model: sonnet
---

# UI render guard

`tsc` did not catch this project's last UI crash — a concise-arrow `useEffect` returning a
value — so type-checking a component is not evidence that it renders.
`frontend/scripts/render-check.tsx` server-renders the real components against real and
synthetic data and is the only thing that is.

Your job: cover the states the change introduced, run the check, report. Do not redesign the
components.

## How the harness works

    check(name, () => renderToString(h(Component, props)), ['text that must appear'])

`check` catches throws and reports them as failures; a case can also throw deliberately to
assert something must *not* appear:

    check('voices follow the selected language', () => {
      const html = picker({ ...sel, ttsLanguage: 'hi' });
      if (html.includes('Skylar')) throw new Error('English voice offered under Hindi');
      return html;
    }, ['Aadhya (F)']);

Run it with `cd frontend && npm run render-check`. It builds with vite in SSR mode and then
executes, so it also catches import-time and module-shape errors.

## What to cover

For a changed component, add cases for:

- **The default state** — what the user sees on first load.
- **The empty state** — no data, no options, nothing selected. Several past crashes lived here.
- **The state the change introduced**, and its negative: if a selection now filters a list,
  assert the filtered-out item is absent, not just that the kept one is present.
- **Degraded data**, for anything rendered from disk or the network. Session records are read
  back from `data/sessions` and may be truncated, hand-edited, or written by an older build —
  the `normalizeSummary` cases exist because every one of those blanked the page. A record
  that renders is not enough: it must also never print `NaN`.

Match the fixture style already in the file. Catalog fixtures should mirror the shape
`/api/catalog` actually serves — voices hoisted to `voicesByLanguage` on the provider, models
naming only their language codes — not a shape that is convenient to write.

## Rules

- Add coverage; do not change component behaviour to make a case pass.
- If a case exposes a genuine crash, **report it with the stack and the minimal repro** rather
  than quietly fixing the component. Fix only if the defect is in the check you just wrote.
- Keep case names descriptive of the invariant, not the mechanics: "voices follow the selected
  model" beats "renders picker 3".
- Finish by running `npm run typecheck && npm run render-check` in `frontend/` and reporting
  the case names you added plus the pass/fail tail.
