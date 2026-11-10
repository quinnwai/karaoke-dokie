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
  /** False once the microphone has been taken away (the permission was withdrawn, a headset was pulled). */
  live(): boolean;
  /** Starts the audio if the browser held it back; call it from a tap. Safe to call any time. */
  resume(): void;
  /** Releases the microphone. */
  close(): void;
}

/** What the browser already says about the microphone, without asking. 'unknown' where it cannot tell (Safari before 16). */
export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface Mic {
  /** Never prompts, never rejects. */
  permission(): Promise<MicPermission>;
  /** Asks for the microphone, which shows the browser's own question the first time. Rejects with MicError when the answer is no. */
  open(): Promise<MicRecorder>;
}

/**
 * Why the microphone is not on. Blocked and closed are told apart because closing the question leaves the
 * way open to ask again; the rest are not about permission at all.
 */
export type MicProblem = 'denied' | 'dismissed' | 'missing' | 'busy' | 'unsupported';

export class MicError extends Error {
  constructor(
    readonly reason: MicProblem,
    message = `Microphone problem: ${reason}`,
  ) {
    super(message);
    this.name = 'MicError';
  }
}

/** Reads getUserMedia's failure. Chrome says "Permission dismissed" when the question was closed without an answer. */
export function classifyMicError(err: unknown): MicProblem {
  const { name = '', message = '' } = (err ?? {}) as { name?: string; message?: string };
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return /dismiss/i.test(message) ? 'dismissed' : 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'missing';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    default:
      return 'unsupported';
  }
}

/** How long to wait for the browser's answer before saying 'unknown', so a browser that never answers cannot hold up the screen. */
const PERMISSION_WAIT_MS = 400;

export async function queryMicPermission(): Promise<MicPermission> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      navigator.permissions.query({ name: 'microphone' as PermissionName }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PERMISSION_WAIT_MS);
      }),
    ]);
    return status ? status.state : 'unknown';
  } catch {
    // No Permissions API, or this browser does not know the name "microphone".
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** How much of the latest sound is kept while nobody is recording: enough for the level meter and the live pitch. */
export const IDLE_KEEP = 8192;

/** Collects Float32 chunks and hands back slices of them. */
export class SampleBuffer {
  private chunks: Float32Array[] = [];
  private length = 0;
  /** From reset() (a hold begins) to stop() (it ends) everything is kept; the rest of the time only the latest IDLE_KEEP. */
  private recording = false;

  push(chunk: Float32Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    if (!this.recording) this.trim();
  }

  reset(): void {
    this.chunks = [];
    this.length = 0;
    this.recording = true;
  }

  /** Everything since reset(). The hold is over, so the buffer goes back to keeping only the latest sound. */
  stop(): Float32Array {
    const all = this.all();
    this.recording = false;
    this.trim();
    return all;
  }

  /** Drops the oldest chunks while IDLE_KEEP samples or more would still be left. */
  private trim(): void {
    while (this.chunks.length > 1 && this.length - this.chunks[0]!.length >= IDLE_KEEP) {
      this.length -= this.chunks.shift()!.length;
    }
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
  permission: queryMicPermission,

  async open() {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported', 'No microphone available');
    // Create the context before any await so it starts inside the tap (iOS Safari).
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
      throw new MicError(classifyMicError(err), err instanceof Error ? err.message : undefined);
    }
    await resumed;
    // A microphone the browser had already allowed opens without a tap, so the first resume() may have been
    // refused. Once the page is capturing, the browser lets the audio start.
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});

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
      take: () => buffer.stop(),
      live: () => stream.getAudioTracks().some((t) => t.readyState === 'live'),
      resume() {
        void ctx.resume().catch(() => {});
      },
      close() {
        source.disconnect();
        node.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close().catch(() => {});
      },
    };
  },
};
