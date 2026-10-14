// Test signal generators. Real voices are rich in harmonics and wobble in
// pitch, so the "voice" generator adds both; pure sines are the easy case.

export const SAMPLE_RATE = 44100;

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function sine(hz: number, seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Sung-vowel-like tone: 8 harmonics with falling strength, plus vibrato. */
export function voice(
  hz: number,
  seconds: number,
  { vibratoCents = 30, vibratoHz = 5.5, sampleRate = SAMPLE_RATE } = {},
): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const amps = [1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08];
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    const f = hz * Math.pow(2, (vibratoCents / 1200) * Math.sin(2 * Math.PI * vibratoHz * t));
    phase += (2 * Math.PI * f) / sampleRate;
    let v = 0;
    amps.forEach((a, k) => (v += a * Math.sin((k + 1) * phase)));
    out[i] = 0.2 * v;
  }
  return out;
}

/** Deterministic white noise so tests never flake. */
export function noise(seconds: number, amplitude = 0.3, sampleRate = SAMPLE_RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = amplitude * ((seed / 0x7fffffff) * 2 - 1);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + (b[i] ?? 0);
  return out;
}
