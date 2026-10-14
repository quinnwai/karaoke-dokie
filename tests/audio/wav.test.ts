import { describe, expect, it } from 'vitest';
import { decodeWav } from '../../src/lib/audio/wav';

function makeWav(samples: number[], sampleRate: number, channels = 1): Uint8Array {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + data, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, data, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return new Uint8Array(buf);
}

describe('decodeWav', () => {
  it('reads mono 16-bit PCM', () => {
    const { samples, sampleRate } = decodeWav(makeWav([0, 16384, -32768], 22050));
    expect(sampleRate).toBe(22050);
    expect(Array.from(samples)).toEqual([0, 0.5, -1]);
  });

  it('averages stereo to mono', () => {
    const { samples } = decodeWav(makeWav([16384, 0, -16384, -16384], 44100, 2));
    expect(Array.from(samples)).toEqual([0.25, -0.5]);
  });

  it('rejects files that are not WAV', () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow('Not a WAV file');
  });
});
