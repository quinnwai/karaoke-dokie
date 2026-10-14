// Microphone capture behind a small interface so tests can swap in a fake.
// Uses an AudioWorklet when available, else a ScriptProcessorNode.

export interface MicRecorder {
  readonly sampleRate: number;
  /** Drops everything recorded so far (start of a new hold). */
  reset(): void;
  /** The most recent `n` samples (fewer if not that many yet). */
  latest(n: number): Float32Array;
  /** Everything since the last reset. */
  take(): Float32Array;
  /** Releases the microphone. */
  close(): void;
}

export interface Mic {
  /** Asks for the microphone. Rejects with MicDeniedError when the user says no. */
  open(): Promise<MicRecorder>;
}

export class MicDeniedError extends Error {
  constructor(message = 'Microphone access was denied') {
    super(message);
    this.name = 'MicDeniedError';
  }
}

/** Collects Float32 chunks and hands back slices of them. */
export class SampleBuffer {
  private chunks: Float32Array[] = [];
  private length = 0;

  push(chunk: Float32Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  reset(): void {
    this.chunks = [];
    this.length = 0;
  }

  latest(n: number): Float32Array {
    const size = Math.min(n, this.length);
    const out = new Float32Array(size);
    let at = size;
    for (let i = this.chunks.length - 1; i >= 0 && at > 0; i--) {
      const chunk = this.chunks[i]!;
      const take = Math.min(at, chunk.length);
      out.set(chunk.subarray(chunk.length - take), at - take);
      at -= take;
    }
    return out;
  }

  all(): Float32Array {
    return this.latest(this.length);
  }
}

const WORKLET = `
class KdTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('kd-tap', KdTap);
`;

export const browserMic: Mic = {
  async open() {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicDeniedError('No microphone available');
    // Create the context before any await so it starts inside the press gesture (iOS Safari).
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const resumed = ctx.resume().catch(() => {});
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (err) {
      void ctx.close().catch(() => {});
      throw new MicDeniedError(err instanceof Error ? err.message : undefined);
    }
    await resumed;

    const source = ctx.createMediaStreamSource(stream);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    silent.connect(ctx.destination);
    const buffer = new SampleBuffer();
    let node: AudioNode;

    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const worklet = new AudioWorkletNode(ctx, 'kd-tap');
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => buffer.push(e.data);
      node = worklet;
    } catch {
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (e) => buffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      node = processor;
    }
    source.connect(node);
    node.connect(silent);

    return {
      sampleRate: ctx.sampleRate,
      reset: () => buffer.reset(),
      latest: (n) => buffer.latest(n),
      take: () => buffer.all(),
      close() {
        source.disconnect();
        node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
      },
    };
  },
};
