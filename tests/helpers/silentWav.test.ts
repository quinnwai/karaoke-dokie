// The audio the e2e specs serve to a page is silent (tests/helpers/silentWav.ts): a WebKit pass plays it out of the speakers of the machine it runs on.

import { describe, expect, it } from 'vitest';
import { silentWav } from './silentWav';

describe('silentWav', () => {
  it('is a real 16-bit mono PCM WAV of the length asked for, as long as a preview (30 s) when asked', () => {
    const wav = silentWav(30);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(22050);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(30 * 22050 * 2);
    expect(wav.length).toBe(44 + 30 * 22050 * 2);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });

  it('has only zero samples: nothing a speaker could play', () => {
    for (const [seconds, rate] of [[30, 22050], [1.5, 22050], [0.25, 44100]] as const) {
      const samples = silentWav(seconds, rate).subarray(44);
      expect(samples.length).toBe(Math.round(seconds * rate) * 2);
      expect(samples.every((byte) => byte === 0), `${seconds} s at ${rate} Hz`).toBe(true);
    }
  });
});
