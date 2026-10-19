/**
 * Copies MagickVoice core's Voice Stack spec into `src/lib/voice-stack/`.
 *
 * Core owns the spec: the schema, the `mvs1.` codec and the language-code
 * normaliser. The bench only produces codes, so it runs core's own files rather
 * than a re-implementation that could drift — a code that encodes here but
 * fails to decode there is the one failure this export must never have. Same
 * rule as `sync-protocol`: the copy is never hand-edited, it is re-synced.
 *
 * Core lives outside this project, so the path is resolved from
 * `MAGIC_VOICE_CORE` (the core repo root) or the default sibling checkout, and
 * the script fails loudly when it is not there rather than leaving a stale copy
 * looking current.
 *
 * "Sibling" means beside THIS repo: `here` is `<repo>/frontend/scripts`, so
 * three `..` reach the directory that holds the repo, and core is looked for
 * there. A checkout anywhere else is reached through `MAGIC_VOICE_CORE`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['spec.ts', 'language.ts', 'canonical-json.ts', 'sha256.ts', 'bytes.ts'];

const here = dirname(fileURLToPath(import.meta.url));
// frontend/scripts → frontend → <repo> → the directory holding <repo>.
const siblingCore = resolve(here, '..', '..', '..', 'magic-voice-core');
const override = process.env.MAGIC_VOICE_CORE?.trim();
const coreRoot = resolve(override || siblingCore);
const source = join(coreRoot, 'src', 'voice-stacks');
const target = join(here, '..', 'src', 'lib', 'voice-stack');

const die = (message) => {
  console.error(`sync-voice-stack-spec: ${message}`);
  process.exit(1);
};

if (!existsSync(source)) {
  const from = override ? 'MAGIC_VOICE_CORE' : 'the default sibling checkout beside this repo';
  die(
    `core spec directory not found at ${source} (from ${from}). ` +
      `Set MAGIC_VOICE_CORE to the magic-voice-core repo root, e.g. ` +
      `MAGIC_VOICE_CORE=/path/to/magic-voice-core npm run sync-voice-stack-spec`,
  );
}

const copies = FILES.map((file) => {
  const from = join(source, file);
  if (!existsSync(from)) die(`missing ${from} — core's spec module set has changed; update FILES here`);
  const body = readFileSync(from, 'utf8');

  // The mirror runs in a browser bundle. Core keeps these files free of every
  // import but `zod` and each other; if that ever changes, refuse to copy
  // rather than ship a bundle that pulls in core internals or Node APIs.
  for (const [, spec] of body.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
    if (spec !== 'zod' && !spec.startsWith('./')) die(`${file} imports "${spec}"; only zod and siblings may be mirrored`);
  }

  const header =
    `// GENERATED — do not edit. Copied from magic-voice-core/src/voice-stacks/${file}\n` +
    `// by \`npm run sync-voice-stack-spec\`; edit it in core and re-run that.\n\n`;
  return { file, text: header + body };
});

mkdirSync(target, { recursive: true });
for (const { file, text } of copies) writeFileSync(join(target, file), text);
console.log(`synced ${copies.length} files from ${source}`);
