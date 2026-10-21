import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as protocol from '../../../src/shared/protocol.js';
import { CANONICAL_SAMPLE_RATE, type ClientMessage, type MetricName, type ServerMessage } from '../../../src/shared/protocol.js';
import { pcm16DurationMs, silence } from '../../../src/audio/pcm.js';

/**
 * protocol.ts is almost entirely types. Its only runtime value is the session
 * boundary's sample rate, which every duration, recording and resample in the
 * bench is computed against.
 */
describe('shared protocol', () => {
  it('the session boundary is 24 kHz', () => {
    expect(CANONICAL_SAMPLE_RATE).toBe(24000);
  });

  it('exports no runtime values besides the sample rate (the rest is the type contract)', () => {
    expect(Object.keys(protocol)).toEqual(['CANONICAL_SAMPLE_RATE']);
  });

  it('pcm defaults agree with it: one second of PCM16 mono is 2 x rate bytes', () => {
    expect(silence(1000).length).toBe(CANONICAL_SAMPLE_RATE * 2);
    expect(pcm16DurationMs(CANONICAL_SAMPLE_RATE * 2)).toBe(1000);
  });

  it('the frontend copy is byte-identical (sync-protocol, never hand-edited)', async () => {
    const backend = await readFile(fileURLToPath(new URL('../../../src/shared/protocol.ts', import.meta.url)), 'utf8');
    const frontend = await readFile(
      fileURLToPath(new URL('../../../../frontend/src/lib/protocol.ts', import.meta.url)),
      'utf8',
    );
    expect(frontend).toBe(backend);
  });

  it('message unions stay discriminated on `type`', () => {
    expectTypeOf<ClientMessage['type']>().toEqualTypeOf<
      'start' | 'user_text' | 'start_recording' | 'commit_audio' | 'interrupt' | 'end_conversation' | 'stop'
    >();
    expectTypeOf<ServerMessage['type']>().toEqualTypeOf<
      | 'session_started'
      | 'transcript'
      | 'turn_start'
      | 'turn_end'
      | 'metrics'
      | 'usage'
      | 'session_summary'
      | 'log'
      | 'error'
      | 'session_closed'
    >();
    expectTypeOf<MetricName>().toEqualTypeOf<
      | 'user_speech_end'
      | 'stt_first_partial'
      | 'stt_final'
      | 'llm_request_sent'
      | 'llm_first_token'
      | 'llm_last_token'
      | 'tts_request_sent'
      | 'tts_first_audio'
      | 'first_audio_out'
      | 'last_audio_out'
    >();
  });
});
