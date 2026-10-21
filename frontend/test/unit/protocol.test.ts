import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANONICAL_SAMPLE_RATE } from '../../src/lib/protocol';
import type { ClientMessage, ServerMessage } from '../../src/lib/protocol';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe('protocol', () => {
  it('fixes the session boundary at 24 kHz', () => {
    expect(CANONICAL_SAMPLE_RATE).toBe(24_000);
  });

  it('is a byte-for-byte copy of the backend contract (npm run sync-protocol)', () => {
    const frontend = readFileSync(here('../../src/lib/protocol.ts'), 'utf8');
    const backend = readFileSync(here('../../../backend/src/shared/protocol.ts'), 'utf8');
    expect(frontend).toBe(backend);
  });

  it('round-trips representative frames through JSON', () => {
    const client: ClientMessage[] = [
      { type: 'start', config: { mode: 'pipeline', systemPrompt: 'x', turnDetection: 'server_vad' } },
      { type: 'user_text', text: 'héllo' },
      { type: 'start_recording' },
      { type: 'commit_audio' },
      { type: 'interrupt' },
      { type: 'end_conversation' },
      { type: 'stop' },
    ];
    const server: ServerMessage[] = [
      { type: 'session_started', sessionId: 's', mode: 'realtime', sampleRate: CANONICAL_SAMPLE_RATE, label: 'l' },
      { type: 'transcript', role: 'user', text: 't', final: true, turnId: 0 },
      { type: 'metrics', turnId: 1, marks: [{ name: 'user_speech_end', atMs: 0 }], derived: { timeToFirstAudioMs: 1 } },
      { type: 'session_closed' },
    ];
    for (const msg of [...client, ...server]) expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});
