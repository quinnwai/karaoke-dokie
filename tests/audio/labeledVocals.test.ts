// Runs the note detector on real sung notes with known pitch.
// Each file in tests/fixtures/vocals is named <NOTE>__<anything>.wav,
// e.g. A3__vocal_acoustic_000-057-100.wav. Sources are listed in SOURCES.md there.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectHeldNote } from '../../src/lib/audio/heldNote';
import { decodeWav } from '../../src/lib/audio/wav';

const DIR = join(__dirname, '../fixtures/vocals');
const files = readdirSync(DIR).filter((f) => f.endsWith('.wav'));

describe('labeled sung notes', () => {
  it('has labeled recordings to test against', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is detected as its labeled note', (file) => {
    const expected = file.split('__')[0];
    const { samples, sampleRate } = decodeWav(readFileSync(join(DIR, file)));
    expect(detectHeldNote(samples, sampleRate)?.note).toBe(expected);
  });
});
