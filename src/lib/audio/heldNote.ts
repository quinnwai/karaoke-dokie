// Finds the note a user held during one press-and-hold recording.
// Splits the recording into short frames, detects pitch per frame, and keeps
// the longest run of frames that stay within a semitone of each other, so a
// breath, a slide into the note, or vibrato does not change the answer.

import { detectPitch, type PitchOptions } from './pitch';
import { frequencyToMidi, midiToFrequency, midiToNoteName } from './notes';

export interface HeldNote {
  note: string;
  midi: number;
  frequency: number;
  /** How long the note was held, in seconds. */
  seconds: number;
}

export interface HeldNoteOptions extends PitchOptions {
  frameSize?: number;
  hopSize?: number;
  /** Shortest hold that counts as a note. */
  minSeconds?: number;
  /** Unvoiced frames allowed inside a run (a brief crack or breath). */
  maxGapFrames?: number;
}

const DEFAULTS = { frameSize: 2048, hopSize: 512, minSeconds: 0.5, maxGapFrames: 4 };

export function frameMidis(samples: Float32Array, sampleRate: number, options: HeldNoteOptions = {}): (number | null)[] {
  const { frameSize, hopSize } = { ...DEFAULTS, ...options };
  const out: (number | null)[] = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const pitch = detectPitch(samples.subarray(start, start + frameSize), sampleRate, options);
    out.push(pitch ? frequencyToMidi(pitch.frequency) : null);
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function detectHeldNote(samples: Float32Array, sampleRate: number, options: HeldNoteOptions = {}): HeldNote | null {
  const { hopSize, minSeconds, maxGapFrames } = { ...DEFAULTS, ...options };
  const midis = frameMidis(samples, sampleRate, options);

  let best: number[] = [];
  let run: number[] = [];
  let gap = 0;
  const close = () => {
    if (run.length > best.length) best = run;
    run = [];
    gap = 0;
  };

  for (const m of midis) {
    if (m === null) {
      if (run.length && ++gap > maxGapFrames) close();
      continue;
    }
    if (run.length && Math.abs(m - median(run)) > 1) close();
    run.push(m);
    gap = 0;
  }
  close();

  const seconds = (best.length * hopSize) / sampleRate;
  if (seconds < minSeconds) return null;
  const midi = Math.round(median(best));
  return { note: midiToNoteName(midi), midi, frequency: midiToFrequency(midi), seconds };
}
