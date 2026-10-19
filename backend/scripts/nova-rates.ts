/**
 * Re-measures Amazon Nova 2 Sonic's published rates, per region.
 *
 *   npm run nova:rates
 *
 * Needs no AWS key — these are public price lists, and nothing is billed.
 *
 * WHY THIS IS A SCRIPT AND NOT A NOTE IN rates.ts
 *
 * The rates in `pricing/rates.ts` were first written from a research pass that
 * cited this feed as their source. An audit then fetched the feed and found no
 * occurrence of "nova", "sonic" or even "speech" anywhere in its 2.2 MB — so
 * the stated provenance could not have been true, and a number whose source is
 * wrong is a number nobody can re-check.
 *
 * It turned out the feed IS the source; it just does not name anything. The
 * rendered pricing page carries placeholders of the form
 *
 *     {priceOf!bedrock/bedrock!<RegionlessRateCode>!*!1000}
 *
 * and those opaque codes are the keys in the feed's per-region maps. Resolving
 * one against the other is the whole measurement, and this script is it. Run it
 * and the numbers either still match `NOVA_SONIC_REGIONS` or they do not.
 *
 * The `!*!1000` suffix is the page's own multiplier: feed prices are per 1K
 * tokens, so a rate "per 1M tokens" is the feed price times 1000.
 *
 * Measured this way on 2026-09-17. If AWS restructures the page, the discovery
 * step below fails loudly rather than silently returning the old codes — that
 * is why the codes are scraped every run instead of being pinned here.
 */

const PRICING_PAGE = 'https://aws.amazon.com/bedrock/pricing/';
const FEED = 'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json';

/**
 * The rows we want, as `<model cell, modality cell>`.
 *
 * The page lays these out as a table — `<tr><td>Amazon Nova 2 Sonic</td>
 * <td>Speech</td><td>{priceOf!…in}</td><td>{priceOf!…out}</td></tr>` — so the
 * model name and the modality are SEPARATE cells. Matching on the joined string
 * "Amazon Nova 2 Sonic Speech" finds nothing, and matching on the model name
 * alone would happily pick up the legacy "Amazon Nova Sonic" row, whose rates
 * are different. Both cells, exactly.
 */
const WANTED: Array<[model: string, modality: string]> = [
  ['Amazon Nova 2 Sonic', 'Speech'],
  ['Amazon Nova 2 Sonic', 'Text'],
];

/** Feed region names -> the AWS_REGION values a user would actually set. */
const REGION_IDS: Record<string, string> = {
  'US East (N. Virginia)': 'us-east-1',
  'US West (Oregon)': 'us-west-2',
  'EU (Stockholm)': 'eu-north-1',
  'Europe (Stockholm)': 'eu-north-1',
  'Asia Pacific (Tokyo)': 'ap-northeast-1',
};

interface FeedEntry {
  rateCode: string;
  price: string;
  RegionlessRateCode?: string;
}

/**
 * No explicit `accept-encoding` header: setting one by hand turns OFF undici's
 * automatic decompression, and both of these URLs are served gzipped, so the
 * body comes back as bytes that parse as neither HTML nor JSON. That failure
 * looks exactly like "AWS changed the page", which is a confusing way to lose
 * an afternoon.
 */
async function get(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

/**
 * Pulls one row's input/output rate codes out of the page.
 *
 * Scoped to a single `<tr>`: the placeholders are positional (first is input,
 * second carries `!opt` and is output) and reading them from anywhere but the
 * matching row would silently pick up a neighbouring model's prices.
 */
function rateCodesFor(page: string, model: string, modality: string): { input: string; output: string } {
  const rows = page.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
  const cell = (text: string) => new RegExp(`<td[^>]*>\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</td>`);
  const row = rows.find((r) => cell(model).test(r) && cell(modality).test(r));
  if (!row) {
    throw new Error(
      `No pricing row for "${model}" / "${modality}". AWS restructured the page — ` +
        'do NOT trust the rates currently in rates.ts until this is fixed.',
    );
  }
  // {priceOf!bedrock/bedrock!<RegionlessRateCode>!*!1000}
  //          ^--- namespace ---^ ^--- the code ---^
  const codes = [...row.matchAll(/\{priceOf![^!]+!([A-Za-z0-9_-]+)!/g)].map((m) => m[1]);
  if (codes.length < 2) {
    throw new Error(`"${model}" / "${modality}" no longer publishes two rate codes (found ${codes.length})`);
  }
  return { input: codes[0], output: codes[1] };
}

const [page, feedRaw] = await Promise.all([get(PRICING_PAGE), get(FEED)]);
const feed = JSON.parse(feedRaw) as {
  manifest?: { hawkFilePublicationDate?: string };
  regions: Record<string, Record<string, FeedEntry>>;
};

console.log(`pricing page: ${PRICING_PAGE}`);
console.log(`feed:         ${FEED}`);
console.log(`feed published: ${feed.manifest?.hawkFilePublicationDate ?? 'unknown'}`);
console.log(`read on:      ${new Date().toISOString().slice(0, 10)}\n`);

const codes = Object.fromEntries(
  WANTED.map(([model, modality]) => [modality, rateCodesFor(page, model, modality)]),
);
for (const [modality, c] of Object.entries(codes)) {
  console.log(`Amazon Nova 2 Sonic / ${modality}\n  in  ${c.input}\n  out ${c.output}`);
}

/**
 * price per 1M tokens = feed price (per 1K) x 1000.
 *
 * Rounded to 4dp because binary floating point turns 0.000396 x 1000 into
 * 0.39599999999999996, and a rate literal that reads like that invites someone
 * to "tidy" it and change the number.
 */
const per1M = (entry?: FeedEntry) =>
  entry ? Number((Number(entry.price) * 1000).toFixed(4)) : undefined;

const rows: Array<{ region: string; speechIn?: number; speechOut?: number; textIn?: number; textOut?: number }> = [];
for (const [regionName, entries] of Object.entries(feed.regions)) {
  const speech = codes.Speech;
  if (!entries[speech.input]) continue; // this region does not serve Nova 2 Sonic
  const text = codes.Text;
  rows.push({
    region: REGION_IDS[regionName] ?? regionName,
    speechIn: per1M(entries[speech.input]),
    speechOut: per1M(entries[speech.output]),
    textIn: per1M(entries[text.input]),
    textOut: per1M(entries[text.output]),
  });
}
rows.sort((a, b) => a.region.localeCompare(b.region));

console.log('\nAmazon Nova 2 Sonic — USD per 1M tokens\n');
console.log('region            speech in  speech out   text in  text out');
for (const r of rows) {
  const f = (n?: number) => (n === undefined ? '       -' : n.toFixed(4).padStart(8));
  console.log(`${r.region.padEnd(16)} ${f(r.speechIn)}  ${f(r.speechOut)}  ${f(r.textIn)}  ${f(r.textOut)}`);
}

console.log('\nAs a NOVA_SONIC_REGIONS literal for src/pricing/rates.ts:\n');
for (const r of rows) {
  if ([r.speechIn, r.speechOut, r.textIn, r.textOut].some((v) => v === undefined)) {
    console.log(`  // ${r.region}: INCOMPLETE — some rate codes are absent, so it is left unpriced`);
    continue;
  }
  console.log(
    `  '${r.region}': { speech: { in: ${r.speechIn}, out: ${r.speechOut} }, ` +
      `text: { in: ${r.textIn}, out: ${r.textOut} } },`,
  );
}

const regions = rows.length;
console.log(`\n${regions} region(s) serve Nova 2 Sonic.`);
if (regions === 0) {
  console.error('FAIL — no region resolved. The page or the feed changed shape; do not trust the rates on file.');
  process.exit(1);
}
