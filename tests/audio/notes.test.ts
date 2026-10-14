import { describe, expect, it } from 'vitest';
import { frequencyToMidi, midiToNoteName, noteNameToMidi } from '../../src/lib/audio/notes';

describe('note names', () => {
  it('maps A4 = 440 Hz to MIDI 69', () => {
    expect(frequencyToMidi(440)).toBeCloseTo(69, 5);
  });

  it('names MIDI notes with sharps and octave numbers', () => {
    expect(midiToNoteName(60)).toBe('C4');
    expect(midiToNoteName(57)).toBe('A3');
    expect(midiToNoteName(42)).toBe('F#2');
    expect(midiToNoteName(84)).toBe('C6');
  });

  it('parses note names, including flats', () => {
    expect(noteNameToMidi('C4')).toBe(60);
    expect(noteNameToMidi('F#2')).toBe(42);
    expect(noteNameToMidi('Bb5')).toBe(82);
    expect(noteNameToMidi('A#5')).toBe(82);
  });

  it('round-trips every note in the singing range', () => {
    for (let m = 36; m <= 96; m++) expect(noteNameToMidi(midiToNoteName(m))).toBe(m);
  });

  it('rejects malformed names', () => {
    expect(() => noteNameToMidi('H2')).toThrow();
  });
});
