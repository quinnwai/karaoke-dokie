// Parser for UltraStar karaoke note files (.txt), the format used by
// UltraStar Deluxe, Vocaluxe and Performous and shared on sites like USDB.
// Format reference: https://usdx.eu/format/
//
// A file is header lines (`#KEY:value`) followed by one line per sung note:
//   `: start length pitch syllable`   normal note
//   `* ...` golden, `F ...` freestyle (not judged), `R ...` rap, `G ...` golden rap
//   `- start [relStart]`               end of a lyric line (phrase)
//   `P1` / `P2`                        duet: following lines belong to that singer
//   `E`                                end of song (optional in practice)
// Beats are quarter-beats of #BPM, so one beat lasts 60 / (BPM * 4) seconds.
// Pitch is semitones from middle C, so MIDI = pitch + 60.
// Real files are messy: commas as decimal points ("312,5"), a UTF-8 BOM,
// CRLF line endings, and syllables that start or end with a space (word gaps).

export type UltrastarNoteType = 'normal' | 'golden' | 'freestyle' | 'rap' | 'rap-golden';

export interface UltrastarNote {
  type: UltrastarNoteType;
  /** Start in beats, always absolute (RELATIVE files are converted). */
  start: number;
  /** Length in beats. */
  length: number;
  /** Raw UltraStar pitch: semitones from C4. */
  pitch: number;
  midi: number;
  /** Lyric text exactly as written, including leading/trailing spaces. "~" continues the previous syllable. */
  syllable: string;
}

export interface UltrastarFile {
  /** Every `#KEY:value` header, keys upper-cased, values trimmed. */
  headers: Record<string, string>;
  title: string;
  artist: string;
  bpm: number;
  /** Milliseconds from the audio start to beat 0. */
  gap: number;
  relative: boolean;
  /** Notes per singer. Solo files have one entry; duets have P1 at index 0, P2 at index 1. */
  players: UltrastarNote[][];
  /** Absolute beats of the `-` phrase-end lines, per singer. */
  phraseEnds: number[][];
}

const NOTE_TYPES: Record<string, UltrastarNoteType> = {
  ':': 'normal',
  '*': 'golden',
  F: 'freestyle',
  R: 'rap',
  G: 'rap-golden',
};

// Type, start, length, pitch, then exactly one separator; the rest is the syllable.
const NOTE_LINE = /^([:*FRG])\s*(-?\d+)\s+(\d+)\s+(-?\d+)(?:[ \t](.*))?$/;
const PHRASE_LINE = /^-\s*(-?\d+)(?:\s+(-?\d+))?/;
const PLAYER_LINE = /^P\s*(\d+)\s*$/;

/** Parses a number that may use a comma as the decimal point. */
function parseDecimal(value: string | undefined): number {
  if (value === undefined) return NaN;
  const v = value.trim().replace(',', '.');
  return v === '' ? NaN : Number(v);
}

export function parseUltrastar(text: string): UltrastarFile {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const headers: Record<string, string> = {};
  const players: UltrastarNote[][] = [[]];
  const phraseEnds: number[][] = [[]];
  let current: number[] = [0]; // indexes of the players receiving notes
  let relative = false;
  let offset = 0; // RELATIVE mode: beat that the current phrase counts from

  const ensurePlayer = (i: number) => {
    while (players.length <= i) {
      players.push([]);
      phraseEnds.push([]);
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/^[ \t]+/, '');
    if (line === '') continue;

    if (line.startsWith('#')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(1, colon).trim().toUpperCase();
      headers[key] = line.slice(colon + 1).trim();
      if (key === 'RELATIVE') relative = headers[key]!.toLowerCase() === 'yes';
      continue;
    }

    if (line[0] === 'E' && line.trim() === 'E') break;

    const player = PLAYER_LINE.exec(line);
    if (player) {
      const n = Number(player[1]);
      // P3 in older duet files means "both singers".
      current = n === 3 ? [0, 1] : [Math.max(0, n - 1)];
      current.forEach(ensurePlayer);
      continue;
    }

    const note = NOTE_LINE.exec(line);
    if (note) {
      const pitch = Number(note[4]);
      const parsed: UltrastarNote = {
        type: NOTE_TYPES[note[1]!]!,
        start: offset + Number(note[2]),
        length: Number(note[3]),
        pitch,
        midi: pitch + 60,
        syllable: note[5] ?? '',
      };
      for (const p of current) players[p]!.push({ ...parsed });
      continue;
    }

    const phrase = PHRASE_LINE.exec(line);
    if (phrase) {
      const at = offset + Number(phrase[1]);
      for (const p of current) phraseEnds[p]!.push(at);
      // RELATIVE: the next phrase counts from the second number (or the first if absent).
      if (relative) offset += Number(phrase[2] ?? phrase[1]);
      continue;
    }
    // Anything else (comments, junk) is ignored, as UltraStar Deluxe does.
  }

  const bpm = parseDecimal(headers.BPM);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new Error(`UltraStar file has no valid #BPM (got ${headers.BPM ?? 'nothing'})`);
  }
  const gap = parseDecimal(headers.GAP);

  return {
    headers,
    title: headers.TITLE ?? '',
    artist: headers.ARTIST ?? '',
    bpm,
    gap: Number.isFinite(gap) ? gap : 0,
    relative,
    players,
    phraseEnds,
  };
}

/** Seconds per UltraStar beat: beats are quarter-beats of #BPM. */
export function secondsPerBeat(bpm: number): number {
  return 60 / (bpm * 4);
}
