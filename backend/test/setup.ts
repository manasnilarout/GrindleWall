import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Runs before every test file, BEFORE any src module is imported. `config.ts`
 * loads `.env` through dotenv, which never overrides a variable that is already
 * defined — so blanking every vendor key here keeps a developer's real `.env`
 * from turning a unit test into a billed call, or flipping readiness.
 */
const VENDOR_KEYS = [
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'SARVAM_API_KEY',
  'CARTESIA_API_KEY',
  'MURF_API_KEY',
  'ANTHROPIC_API_KEY',
  // Catalog entries not wired up yet; blanked so readiness cannot flip either.
  'DEEPGRAM_API_KEY',
  'ASSEMBLYAI_API_KEY',
  'GROQ_API_KEY',
  'AUTH_PASSWORD',
  'AUTH_HMAC_SECRET',
];
for (const k of VENDOR_KEYS) process.env[k] = '';

// Never write records into the repo's data/sessions. Removed again after the
// file, so repeated local runs do not pile up temp dirs.
const sessionDir = mkdtempSync(join(tmpdir(), 'grindelwald-test-'));
process.env.SESSION_DIR = sessionDir;
afterAll(() => rmSync(sessionDir, { recursive: true, force: true }));
