import { describe, expect, it } from 'vitest';
import { parseUltrastar } from '../../src/lib/songs/ultrastar';
import { fixture } from './fixture';

describe('parseUltrastar headers', () => {
  it('reads title, artist, BPM, GAP and keeps every header', () => {
    const song = parseUltrastar(fixture('solo.txt'));
    expect(song.title).toBe('Solo Song');
    expect(song.artist).toBe('Test Artist');
    expect(song.bpm).toBe(300);
    expect(song.gap).toBe(1000);
    expect(song.relative).toBe(false);
    expect(song.headers.MP3).toBe('solo.mp3');
  });

  it('accepts a comma as decimal separator in BPM and GAP', () => {
    expect(parseUltrastar(fixture('comma-bpm.txt')).bpm).toBe(187.5);
    const crlf = parseUltrastar(fixture('crlf-bom.txt'));
    expect(crlf.bpm).toBe(312.5);
    expect(crlf.gap).toBe(1500.5);
  });

  it('handles a byte-order mark and CRLF line endings', () => {
    const song = parseUltrastar(fixture('crlf-bom.txt'));
    expect(song.title).toBe('Crlf Song');
    expect(song.artist).toBe('Windows Writer');
    expect(song.players[0]!.map((n) => n.syllable)).toEqual(['a', 'b', 'c']);
  });

  it('upper-cases header keys and trims values', () => {
    const song = parseUltrastar('#title: Lower \n#Bpm: 120 \n: 0 1 0 x\n');
    expect(song.title).toBe('Lower');
    expect(song.bpm).toBe(120);
  });

  it('throws when BPM is missing or not a number', () => {
    expect(() => parseUltrastar('#TITLE:x\n: 0 1 0 a\n')).toThrow(/BPM/);
    expect(() => parseUltrastar('#BPM:fast\n: 0 1 0 a\n')).toThrow(/BPM/);
  });
});

describe('parseUltrastar notes', () => {
  it('reads note type, start, length, pitch and MIDI (pitch 0 = C4 = 60)', () => {
    const notes = parseUltrastar(fixture('solo.txt')).players[0]!;
    expect(notes[0]).toEqual({ type: 'normal', start: 0, length: 4, pitch: 0, midi: 60, syllable: 'Hel' });
    expect(notes[2]).toMatchObject({ type: 'golden', midi: 67, syllable: 'world' });
    expect(notes[3]).toMatchObject({ type: 'normal', pitch: -5, midi: 55 });
    expect(notes[4]!.type).toBe('freestyle');
    expect(notes[5]!.type).toBe('rap');
  });

  it('keeps spaces inside and around syllables', () => {
    const notes = parseUltrastar(fixture('solo.txt')).players[0]!;
    expect(notes[1]!.syllable).toBe('lo ');
    expect(notes[6]!.syllable).toBe(' to day');
  });

  it('reads rap, golden rap and freestyle notes', () => {
    const types = parseUltrastar(fixture('rap.txt')).players[0]!.map((n) => n.type);
    expect(types).toEqual(['normal', 'rap', 'rap-golden', 'freestyle', 'golden', 'normal']);
  });

  it('records phrase ends', () => {
    const song = parseUltrastar(fixture('solo.txt'));
    expect(song.phraseEnds[0]).toEqual([20]);
  });

  it('works without an E line and ignores anything after E', () => {
    expect(parseUltrastar(fixture('comma-bpm.txt')).players[0]).toHaveLength(2);
    const song = parseUltrastar('#BPM:100\n: 0 1 0 a\nE\n: 5 1 0 b\n');
    expect(song.players[0]).toHaveLength(1);
  });

  it('skips blank and unknown lines', () => {
    const song = parseUltrastar('#BPM:100\n\n: 0 1 0 a\n?? junk\n: 2 1 0 b\n');
    expect(song.players[0]!.map((n) => n.syllable)).toEqual(['a', 'b']);
  });

  it('splits duets into players on P1 / P2 lines', () => {
    const song = parseUltrastar(fixture('duet.txt'));
    expect(song.headers.P1).toBe('Singer One');
    expect(song.players).toHaveLength(2);
    expect(song.players[0]!.map((n) => n.syllable)).toEqual(['one', 'two']);
    expect(song.players[1]!.map((n) => n.syllable)).toEqual(['three', 'four']);
  });

  it('gives notes after a P3 line to both players (old duet files)', () => {
    const song = parseUltrastar('#BPM:100\nP1\n: 0 1 0 a\nP2\n: 2 1 0 b\nP3\n: 4 1 0 both\n');
    expect(song.players[0]!.map((n) => n.syllable)).toEqual(['a', 'both']);
    expect(song.players[1]!.map((n) => n.syllable)).toEqual(['b', 'both']);
  });

  it('converts RELATIVE beats to absolute beats', () => {
    const song = parseUltrastar(fixture('relative.txt'));
    expect(song.relative).toBe(true);
    expect(song.players[0]!.map((n) => n.start)).toEqual([0, 4, 12, 16]);
  });
});
