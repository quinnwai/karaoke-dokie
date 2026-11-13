// The audio the e2e specs serve to a page (a song's preview) is silent. WebKit has no switch to mute a page, and a WebKit pass plays whatever its page
// plays out of the speakers of the machine running it; Chromium is kept off the speakers by `--disable-audio-output` in every launch
// (playwright.config.ts, tests/e2e/fakeMic.ts, tests/e2e/screen.spec.ts). So a spec that serves audio serves this: the same length and format as a
// preview, every sample zero. tests/helpers/silentWav.test.ts checks it.

/** A 16-bit mono PCM WAV of `seconds` of silence at `sampleRate`: a real header, and every sample zero. */
export function silentWav(seconds: number, sampleRate = 22050): Buffer {
  const data = Buffer.alloc(Math.round(seconds * sampleRate) * 2);
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
