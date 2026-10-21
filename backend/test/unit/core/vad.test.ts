import { describe, expect, it } from 'vitest';
import { SpeechEndDetector, type VadState } from '../../../src/audio/vad.js';
import { rms } from '../../../src/audio/pcm.js';
import { CANONICAL_SAMPLE_RATE } from '../../../src/shared/protocol.js';
import { pcm } from './helpers.js';

const SR = CANONICAL_SAMPLE_RATE;
/** 20 ms frame at 24 kHz. */
const FRAME = SR / 50;
const loud = () => pcm(FRAME, 3000); // rms ~0.092, well over the 0.012 default
const quiet = () => pcm(FRAME, 0);

/** Pushes `count` frames and returns every state. */
function run(vad: SpeechEndDetector, frame: () => Buffer, count: number, rate = SR): VadState[] {
  const out: VadState[] = [];
  for (let i = 0; i < count; i++) out.push(vad.push(frame(), rate));
  return out;
}

describe('SpeechEndDetector', () => {
  it('stays idle on silence from a fresh start', () => {
    const vad = new SpeechEndDetector();
    expect(run(vad, quiet, 100)).toEqual(Array(100).fill('idle'));
    expect(vad.speaking).toBe(false);
  });

  it('reports speech on a frame above the threshold', () => {
    const vad = new SpeechEndDetector();
    expect(vad.push(loud(), SR)).toBe('speech');
    expect(vad.speaking).toBe(true);
  });

  it('ends after the default 600 ms of trailing silence, not a frame sooner', () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 25); // 500 ms of speech
    const tail = run(vad, quiet, 30);
    expect(tail.slice(0, 29)).toEqual(Array(29).fill('speech'));
    expect(tail[29]).toBe('end');
    expect(vad.speaking).toBe(false);
  });

  it("returns 'end' exactly once per utterance", () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 25);
    const states = run(vad, quiet, 200);
    expect(states.filter((s) => s === 'end')).toHaveLength(1);
    expect(states.slice(30)).toEqual(Array(170).fill('idle'));
  });

  it('reports a fresh end for each of several utterances', () => {
    const vad = new SpeechEndDetector();
    const ends: number[] = [];
    for (let u = 0; u < 3; u++) {
      run(vad, loud, 20);
      run(vad, quiet, 40).forEach((s, i) => s === 'end' && ends.push(i));
    }
    expect(ends).toEqual([29, 29, 29]);
  });

  it('ignores a blip shorter than the default 250 ms minimum (a cough is not a turn)', () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 12); // 240 ms
    const tail = run(vad, quiet, 40);
    expect(tail).not.toContain('end');
    // ...the edge still resets it, so it is idle afterwards.
    expect(tail[29]).toBe('idle');
    expect(vad.speaking).toBe(false);
  });

  it('accepts speech of exactly the minimum length (>=)', () => {
    const vad = new SpeechEndDetector({ minSpeechMs: 240 });
    run(vad, loud, 12); // 240 ms
    expect(run(vad, quiet, 30)[29]).toBe('end');
  });

  it('accumulates speech across short gaps toward the minimum', () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 5); // 100 ms
    run(vad, quiet, 10); // 200 ms gap, under the 600 ms limit
    run(vad, loud, 10); // +200 ms speech = 300 ms total
    expect(run(vad, quiet, 30)[29]).toBe('end');
  });

  it('does not count silence frames toward the speech minimum', () => {
    const vad = new SpeechEndDetector({ minSpeechMs: 250, silenceMs: 600 });
    run(vad, loud, 5); // 100 ms
    run(vad, quiet, 25); // 500 ms in-speech silence
    run(vad, loud, 5); // 200 ms of speech overall
    expect(run(vad, quiet, 30)).not.toContain('end');
  });

  it('resets the silence counter when speech resumes', () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 20);
    expect(run(vad, quiet, 25)).not.toContain('end'); // 500 ms
    vad.push(loud(), SR);
    const tail = run(vad, quiet, 30);
    expect(tail.slice(0, 29)).not.toContain('end');
    expect(tail[29]).toBe('end');
  });

  it('treats the threshold as strictly greater-than', () => {
    const frame = pcm(FRAME, 1000);
    const atThreshold = new SpeechEndDetector({ threshold: rms(frame) });
    expect(atThreshold.push(frame, SR)).toBe('idle');
    const justUnder = new SpeechEndDetector({ threshold: rms(frame) - 1e-9 });
    expect(justUnder.push(frame, SR)).toBe('speech');
  });

  it('uses 0.012 as the default threshold', () => {
    // 0.012 * 32768 = 393.2: 393 is below, 394 is above.
    expect(new SpeechEndDetector().push(pcm(FRAME, 393), SR)).toBe('idle');
    expect(new SpeechEndDetector().push(pcm(FRAME, 394), SR)).toBe('speech');
  });

  it('honours a custom silence limit', () => {
    const vad = new SpeechEndDetector({ silenceMs: 100 });
    run(vad, loud, 20);
    const tail = run(vad, quiet, 5);
    expect(tail.slice(0, 4)).toEqual(Array(4).fill('speech'));
    expect(tail[4]).toBe('end');
  });

  it('measures durations against the sample rate it is given', () => {
    // A 320-sample frame is 20 ms at 16 kHz but only 13.3 ms at 24 kHz.
    const frame16 = () => pcm(320, 3000);
    const silent16 = () => pcm(320, 0);
    const vad = new SpeechEndDetector();
    run(vad, frame16, 15, 16000); // 300 ms
    const tail = run(vad, silent16, 30, 16000);
    expect(tail[28]).toBe('speech');
    expect(tail[29]).toBe('end');
  });

  it('treats an empty chunk as zero-length silence', () => {
    const vad = new SpeechEndDetector();
    expect(vad.push(Buffer.alloc(0), SR)).toBe('idle');
    run(vad, loud, 20);
    // While speaking, an empty chunk adds no silence and so never ends a turn.
    expect(run(vad, () => Buffer.alloc(0), 1000)).toEqual(Array(1000).fill('speech'));
    expect(vad.speaking).toBe(true);
  });

  it('can end on the first silent frame when the silence limit is 0', () => {
    const vad = new SpeechEndDetector({ silenceMs: 0, minSpeechMs: 0 });
    vad.push(loud(), SR);
    expect(vad.push(Buffer.alloc(0), SR)).toBe('end');
  });

  it('reset() abandons an utterance mid-way', () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 20);
    vad.reset();
    expect(vad.speaking).toBe(false);
    expect(run(vad, quiet, 40)).toEqual(Array(40).fill('idle'));
  });

  it('reset() clears accumulated speech, so a later blip is judged on its own', () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 20); // 400 ms
    vad.reset();
    run(vad, loud, 5); // 100 ms
    expect(run(vad, quiet, 30)).not.toContain('end');
  });

  it('a short blip does not leak its speech time into the next utterance', () => {
    const vad = new SpeechEndDetector();
    run(vad, loud, 10); // 200 ms
    run(vad, quiet, 30); // resets at 600 ms
    run(vad, loud, 5); // 100 ms; 300 ms only if the blip leaked
    expect(run(vad, quiet, 30)).not.toContain('end');
  });
});
