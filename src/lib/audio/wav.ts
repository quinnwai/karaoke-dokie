// Minimal WAV reader for 16-bit PCM files, used to load test recordings
// without needing ffmpeg at test time. Multi-channel files are averaged to mono.

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');

  let channels = 0, sampleRate = 0, bits = 0, format = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16) throw new Error(`Only 16-bit PCM WAV is supported (format ${format}, ${bits} bits)`);
      const frames = Math.floor(size / (2 * channels));
      const samples = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += view.getInt16(body + 2 * (f * channels + c), true);
        samples[f] = sum / channels / 32768;
      }
      return { samples, sampleRate };
    }
    at = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk');
}
