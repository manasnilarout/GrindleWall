/**
 * Asks Google and OpenAI which models actually exist, and checks the catalog
 * against the answer.
 *
 *   npm run models
 *
 * This is the committed probe behind every "Measured" claim in the README's
 * "Five providers that have never spoken to their vendor" section. Those claims
 * were true when they were written and unreproducible, which per the repo's
 * claim-discipline rule makes them a gap rather than a finished claim: the next
 * person's question is always "is that still true?", and the answer should be
 * one command.
 *
 * BOTH ENDPOINTS ARE FREE. `GET /v1beta/models` and `GET /v1/models` are list
 * calls, not inference, so this bills nothing and can be run on a depleted
 * account — which is exactly the situation it was written in. It deliberately
 * makes no billable call, so it proves that a model id EXISTS and nothing at
 * all about what a request to it would be accepted.
 *
 * What it can tell you:
 *   · every model id in catalog.ts still exists on the account
 *   · Google's `supportedGenerationMethods`, which is why gemini-stt rides the
 *     Live API socket (`bidiGenerateContent`) and gemini-tts is an HTTP request
 *   · that a key works at all — a 429 here is the account, not the code
 *
 * Missing keys are skipped, not failed: this must stay runnable with whatever
 * subset of credentials happens to be present.
 */
import 'dotenv/config';
import { CATALOG } from '../src/providers/catalog.js';

const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000';
const OPENAI = 'https://api.openai.com/v1/models';

interface Probe {
  ids: Set<string>;
  /** Google only: model id -> the methods it publishes. */
  methods: Map<string, string[]>;
}

const empty = (): Probe => ({ ids: new Set(), methods: new Map() });

async function google(key: string): Promise<Probe> {
  const res = await fetch(GOOGLE, { headers: { 'x-goog-api-key': key } });
  const body = (await res.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    error?: { message?: string; code?: number };
  };
  if (!res.ok || body.error) {
    throw new Error(`HTTP ${res.status}: ${body.error?.message ?? 'unknown'}`);
  }
  const out = empty();
  for (const m of body.models ?? []) {
    const id = (m.name ?? '').replace(/^models\//, '');
    if (!id) continue;
    out.ids.add(id);
    out.methods.set(id, m.supportedGenerationMethods ?? []);
  }
  return out;
}

async function openai(key: string): Promise<Probe> {
  const res = await fetch(OPENAI, { headers: { Authorization: `Bearer ${key}` } });
  const body = (await res.json()) as { data?: Array<{ id?: string }>; error?: { message?: string } };
  if (!res.ok || body.error) {
    throw new Error(`HTTP ${res.status}: ${body.error?.message ?? 'unknown'}`);
  }
  const out = empty();
  for (const m of body.data ?? []) if (m.id) out.ids.add(m.id);
  return out;
}

/** Catalog ids carry this repo's `@variant` reasoning suffix; vendors do not. */
const wireId = (modelId: string) => modelId.split('@')[0];

const results: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);

/** Which catalog providers are served by which vendor listing. */
const VENDORS: Array<{ label: string; env: string; providers: string[]; fetch: (k: string) => Promise<Probe> }> = [
  {
    label: 'Google',
    env: 'GOOGLE_API_KEY',
    providers: ['google-llm', 'gemini-tts', 'gemini-stt'],
    fetch: google,
  },
  {
    label: 'OpenAI',
    env: 'OPENAI_API_KEY',
    providers: ['openai-llm', 'openai-realtime'],
    fetch: openai,
  },
];

for (const vendor of VENDORS) {
  const key = process.env[vendor.env];
  if (!key) {
    console.log(`\n${vendor.label}: skipped — ${vendor.env} is not set`);
    continue;
  }

  let probe: Probe;
  try {
    probe = await vendor.fetch(key);
  } catch (err) {
    // A listing failure is worth failing on: it means the key or the account is
    // in a state where nothing else in this repo will work either.
    console.log(`\n${vendor.label}: LISTING FAILED — ${(err as Error).message}`);
    check(`${vendor.label}: model listing answers`, false, (err as Error).message);
    continue;
  }

  console.log(`\n${vendor.label}: ${probe.ids.size} models visible to this key`);
  check(`${vendor.label}: model listing answers`, true, `${probe.ids.size} models`);

  for (const providerId of vendor.providers) {
    const entry = CATALOG.find((p) => p.id === providerId);
    if (!entry?.implemented) continue;
    const missing = entry.models.map((m) => wireId(m.id)).filter((id) => !probe.ids.has(id));
    check(
      `${providerId}: every catalog model id exists`,
      missing.length === 0,
      missing.length ? `missing: ${[...new Set(missing)].join(', ')}` : `${entry.models.length} ids`,
    );
  }

  // The structural fact the speech providers are built on. Google's listing is
  // under-inclusive about streaming (it never reports `streamGenerateContent`
  // for any model), so this asserts only what the field is reliable for: which
  // SURFACE serves a model.
  if (vendor.label === 'Google') {
    const live = probe.methods.get('gemini-3.5-transcribe-live') ?? [];
    check(
      'gemini-3.5-transcribe-live is bidiGenerateContent-only (hence the Live API socket)',
      live.includes('bidiGenerateContent') && !live.includes('generateContent'),
      live.join(', ') || 'model absent',
    );
    for (const tts of ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts']) {
      const methods = probe.methods.get(tts) ?? [];
      check(
        `${tts} is served by generateContent (hence an HTTP request)`,
        methods.includes('generateContent'),
        methods.join(', ') || 'model absent',
      );
    }
  }
}

let failed = 0;
console.log('');
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed += 1;
}

if (results.length === 0) {
  console.log('\nNo keys present — nothing probed.');
  process.exit(0);
}
console.log(failed ? `\n${failed}/${results.length} FAILED` : `\nALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
