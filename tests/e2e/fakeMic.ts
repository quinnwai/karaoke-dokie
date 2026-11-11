// A fake microphone for the e2e specs that need one (QWW-50): Chromium plays a generated WAV as the microphone
// and says yes to its own permission question. It takes one file per launch, and plays it round and round.

import { chromium, type Browser } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 16-bit mono WAV of a sung-vowel-like tone (fundamental plus falling harmonics). */
export function toneWav(hz: number, seconds: number, sampleRate = 48000): Buffer {
  const n = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  const amps = [1, 0.6, 0.4, 0.25, 0.15];
  for (let i = 0; i < n; i++) {
    let v = 0;
    amps.forEach((a, k) => (v += a * Math.sin((2 * Math.PI * hz * (k + 1) * i) / sampleRate)));
    data.writeInt16LE(Math.round(v * 0.22 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Writes a tone under test-results/audio and returns its path. */
export function writeTone(name: string, hz: number, seconds = 2.5): string {
  const dir = path.resolve('test-results/audio');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, toneWav(hz, seconds));
  return file;
}

/** Chromium with a fake microphone that hears `wav`, and a permission question that answers itself. */
export function launchWithMic(wav: string): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.PW_CHROMIUM_PATH,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
}
