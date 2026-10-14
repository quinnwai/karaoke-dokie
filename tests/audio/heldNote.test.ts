import { describe, expect, it } from 'vitest';
import { detectHeldNote } from '../../src/lib/audio/heldNote';
import { SAMPLE_RATE, concat, midiToHz, mix, noise, voice } from '../helpers/synth';
import { noteNameToMidi } from '../../src/lib/audio/notes';

const hz = (name: string) => midiToHz(noteNameToMidi(name));

describe('detectHeldNote on a press-and-hold recording', () => {
  it('reports the note held for 1.5 s with vibrato', () => {
    const rec = voice(hz('A2'), 1.5, { vibratoCents: 40 });
    expect(detectHeldNote(rec, SAMPLE_RATE)?.note).toBe('A2');
  });

  it('ignores a breath and a short slide before the held note', () => {
    const rec = concat(noise(0.3, 0.05), voice(hz('C4'), 0.15), voice(hz('E5'), 1.2));
    expect(detectHeldNote(rec, SAMPLE_RATE)?.note).toBe('E5');
  });

  it('still finds the note with background noise', () => {
    const clean = voice(hz('G3'), 1.5);
    expect(detectHeldNote(mix(clean, noise(1.5, 0.03)), SAMPLE_RATE)?.note).toBe('G3');
  });

  it('returns null when nothing is held long enough', () => {
    const rec = concat(voice(hz('C3'), 0.2), voice(hz('G3'), 0.2), voice(hz('C4'), 0.2));
    expect(detectHeldNote(rec, SAMPLE_RATE)).toBeNull();
  });

  it('returns null for silence', () => {
    expect(detectHeldNote(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)).toBeNull();
  });
});
