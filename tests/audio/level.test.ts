import { describe, expect, it } from 'vitest';
import { SCRIPT_CHUNK, WORKLET_CHUNK } from '../../src/lib/client/mic';
import { isDigitalSilence, MIN_MUTED_SAMPLES } from '../../src/lib/audio/level';
import { noise, voice } from '../helpers/synth';

describe('MIN_MUTED_SAMPLES', () => {
  it('stays above the biggest recorder chunk, twice over, so a tap can never look muted', () => {
    expect(MIN_MUTED_SAMPLES).toBeGreaterThan(2 * Math.max(WORKLET_CHUNK, SCRIPT_CHUNK));
  });
});

describe('isDigitalSilence', () => {
  it('is true for a long run of exact zeros: a microphone the system muted', () => {
    expect(isDigitalSilence(new Float32Array(48000))).toBe(true);
    expect(isDigitalSilence(new Float32Array(MIN_MUTED_SAMPLES))).toBe(true);
  });

  it('is false for an empty or short take: a quick tap on the hold button is a short hold, not a muted mic', () => {
    expect(isDigitalSilence(new Float32Array(0))).toBe(false);
    expect(isDigitalSilence([0, 0, 0])).toBe(false);
    expect(isDigitalSilence(new Float32Array(2048 * 2))).toBe(false); // two of the largest recorder chunks
  });

  it('is false for any sound at all, even a quiet room\'s hiss', () => {
    expect(isDigitalSilence(noise(0.5, 1e-6))).toBe(false);
    expect(isDigitalSilence(voice(220, 0.1))).toBe(false);
    const oneSample = new Float32Array(48000);
    oneSample[47999] = 1e-9;
    expect(isDigitalSilence(oneSample)).toBe(false);
  });
});
