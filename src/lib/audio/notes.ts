// Note name helpers. MIDI numbers are the internal unit everywhere:
// C4 (middle C) = 60, A4 (440 Hz) = 69, one step = one semitone.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const OFFSETS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function frequencyToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export function noteNameToMidi(name: string): number {
  const match = /^([A-G])([#b]?)(-?\d)$/.exec(name.trim());
  if (!match) throw new Error(`Not a note name: ${name}`);
  const [, letter, accidental, octave] = match;
  const shift = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return (Number(octave) + 1) * 12 + OFFSETS[letter!]! + shift;
}
