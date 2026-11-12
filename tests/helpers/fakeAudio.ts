// A stand-in for the one <audio> element the row previews share (QWW-48), close enough to a browser's for the
// player's rules: play() answers later, and a new load or a pause cuts a pending play() short with AbortError.

export class FakeAudio extends EventTarget {
  paused = true;
  ended = false;
  currentTime = 0;
  duration = NaN;
  /** Set when the current load failed, as a browser sets it. */
  error: { code: number } | null = null;
  /** Every address set, in order. */
  readonly srcs: string[] = [];
  /** What happened, in order: 'src:<address>', 'play', 'pause', 'load'. */
  readonly log: string[] = [];
  private address = '';
  private pending: { resolve(): void; reject(err: unknown): void } | null = null;

  get src(): string {
    return this.address;
  }

  set src(value: string) {
    this.cut(); // a new load cuts the old one's play() short
    this.address = value;
    this.srcs.push(value);
    this.log.push(`src:${value}`);
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = NaN;
    this.error = null;
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.address = '';
  }

  play(): Promise<void> {
    this.log.push('play');
    this.paused = false;
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  pause(): void {
    this.log.push('pause');
    this.cut();
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.dispatchEvent(new Event('pause')));
  }

  load(): void {
    this.log.push('load');
    this.cut();
  }

  // ---- what the network and the media stack would do ----

  /** The current load started: its length is known ('loadedmetadata'), then play() resolves and 'playing' fires. */
  start(duration = 30): void {
    this.duration = duration;
    this.dispatchEvent(new Event('loadedmetadata'));
    const p = this.pending;
    this.pending = null;
    this.dispatchEvent(new Event('playing'));
    p?.resolve();
  }

  /** The current load failed (no preview, Deezer down): 'error' fires and play() rejects. */
  fail(): void {
    const p = this.pending;
    this.pending = null;
    this.paused = true;
    this.error = { code: 4 };
    this.dispatchEvent(new Event('error'));
    p?.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'));
  }

  /** The browser refused to play outside a tap. */
  refuse(): void {
    const p = this.pending;
    this.pending = null;
    this.paused = true;
    p?.reject(new DOMException('play() can only be initiated by a user gesture.', 'NotAllowedError'));
  }

  /** Played again by something outside the page: the lock screen, headphones. */
  resumeFromOutside(): void {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
  }

  /** A 'playing' event that was already queued when the page paused the element. */
  latePlaying(): void {
    this.dispatchEvent(new Event('playing'));
  }

  /** The download broke off after it had played (the network, or a link that ran out). */
  breakOff(): void {
    this.error = { code: 2 };
    this.dispatchEvent(new Event('error'));
  }

  /** Paused by the phone itself (a call, Siri) while still loading: play() is cut short and 'pause' fires. */
  interrupt(): void {
    const p = this.pending;
    this.pending = null;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
    p?.reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
  }

  /** The preview played to its end. */
  finish(): void {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('pause'));
    this.dispatchEvent(new Event('ended'));
  }

  private cut(): void {
    const p = this.pending;
    this.pending = null;
    p?.reject(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'));
  }
}

/** Lets promise callbacks and queued microtasks run. */
export const settle = () => new Promise<void>((r) => setTimeout(r, 0));
