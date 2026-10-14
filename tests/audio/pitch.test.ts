import { describe, expect, it } from 'vitest';
import { detectPitch } from '../../src/lib/audio/pitch';
import { frequencyToMidi } from '../../src/lib/audio/notes';
import { SAMPLE_RATE, midiToHz, noise, sine, voice } from '../helpers/synth';

const FRAME = 2048;
const frameOf = (s: Float32Array) => s.subarray(0, FRAME);

// Bass low E (E2, MIDI 40) up to soprano high C (C6, MIDI 84).
const SINGING_RANGE = Array.from({ length: 84 - 40 + 1 }, (_, i) => 40 + i);

describe('detectPitch on a single frame', () => {
  it.each(SINGING_RANGE)('finds MIDI %i from a pure sine within 10 cents', (midi) => {
    const result = detectPitch(frameOf(sine(midiToHz(midi), 0.1)), SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.abs(frequencyToMidi(result!.frequency) - midi)).toBeLessThan(0.1);
  });

  it.each(SINGING_RANGE)('finds MIDI %i from a harmonic-rich voice, not an octave off', (midi) => {
    const result = detectPitch(frameOf(voice(midiToHz(midi), 0.1, { vibratoCents: 0 })), SAMPLE_RATE);
    expect(result).not.toBeNull();
    expect(Math.round(frequencyToMidi(result!.frequency))).toBe(midi);
  });

  it('returns null for silence', () => {
    expect(detectPitch(new Float32Array(FRAME), SAMPLE_RATE)).toBeNull();
  });

  it('returns null for noise', () => {
    expect(detectPitch(frameOf(noise(0.1)), SAMPLE_RATE)).toBeNull();
  });
});
