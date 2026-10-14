// Single-frame pitch detection with the YIN algorithm
// (de Cheveigné & Kawahara, 2002, https://doi.org/10.1121/1.1458024).
// Pure TypeScript so the same code runs in the browser (live mic) and in tests.

export interface PitchResult {
  frequency: number;
  /** 0 to 1. How periodic the frame is; 1 is a perfect tone. */
  clarity: number;
}

export interface PitchOptions {
  minHz?: number;
  maxHz?: number;
  /** YIN threshold: lower is stricter about calling something a pitch. */
  threshold?: number;
  /** Frames quieter than this RMS are treated as silence. */
  minRms?: number;
}

// Defaults cover a low bass (E1 is ~41 Hz, but nobody sings it at karaoke)
// up past a soprano's high C (C6 is ~1047 Hz).
const DEFAULTS = { minHz: 60, maxHz: 1400, threshold: 0.15, minRms: 0.01 };

export function detectPitch(frame: Float32Array, sampleRate: number, options: PitchOptions = {}): PitchResult | null {
  const { minHz, maxHz, threshold, minRms } = { ...DEFAULTS, ...options };

  let energy = 0;
  for (let i = 0; i < frame.length; i++) energy += frame[i]! * frame[i]!;
  if (Math.sqrt(energy / frame.length) < minRms) return null;

  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(frame.length / 2));
  const window = frame.length - maxTau;

  // Difference function, then cumulative mean normalized difference (YIN steps 2 and 3).
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const delta = frame[i]! - frame[i + tau]!;
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau]!;
    cmnd[tau] = running === 0 ? 1 : (d[tau]! * tau) / running;
  }

  // Absolute threshold (step 4): first dip under the threshold, walked down to its bottom.
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if (cmnd[t]! < threshold) {
      while (t + 1 <= maxTau && cmnd[t + 1]! < cmnd[t]!) t++;
      tau = t;
      break;
    }
  }
  if (tau === -1) return null;

  // Parabolic interpolation (step 5) for sub-sample accuracy.
  let betterTau = tau;
  if (tau > 1 && tau < maxTau) {
    const a = cmnd[tau - 1]!, b = cmnd[tau]!, c = cmnd[tau + 1]!;
    const denom = a + c - 2 * b;
    if (denom !== 0) betterTau = tau + (a - c) / (2 * denom);
  }

  return { frequency: sampleRate / betterTau, clarity: 1 - cmnd[tau]! };
}
