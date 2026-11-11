// One <audio> element plays every row's 30 s Deezer preview (QWW-48), so only one song plays at a time and a tap on
// another row switches at once. The element's address is GET /api/preview/<deezerId>, which redirects to the
// preview (server/preview.ts), so a tap sets it and calls play() in the same tick: iOS plays audio only when it is
// started inside the tap. No React here; PreviewButton.tsx draws the state.
//
// The latest tap always wins. Each play() gets a turn number, and the answer to an older one (a load cut short by a
// newer tap rejects with AbortError) changes nothing, so five taps in five seconds end with the fifth song playing.
//
// The player holds a row (its track id), not a Deezer track, so two rows that share one Deezer track never both show
// ⏸, and one of them leaving the list does not stop the other.

/** What one row's button shows. 'loading' is between the tap and the first sound. */
export type PreviewStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface PreviewSnapshot {
  /** The row the player holds (its track id), or null when it holds none. */
  key: string | null;
  status: PreviewStatus;
  /** Deezer tracks the route said have no preview (404) since the page opened; their buttons stay disabled. */
  missing: ReadonlySet<number>;
}

export interface PreviewPlayer {
  snapshot(): PreviewSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Plays row `key`'s preview (Deezer track `deezerId`), or pauses or resumes it when it is the row held. Call it
   * inside the tap's handler.
   */
  toggle(key: string, deezerId: number): void;
  /** Stops row `key` when it is the one held: its row went away (the song page opened, or a filter took it off). */
  release(key: string): void;
  /** How far the held preview has played, 0 to 1. */
  progress(): number;
}

/**
 * Why a preview that never made a sound would not load. The <audio> element cannot tell, so the route is asked once:
 * 'missing' when Deezer has no preview (404, or 400 for an id that is no track), else 'retry' (Deezer slow or down,
 * the network, the CDN).
 */
export type PreviewCheck = (deezerId: number) => Promise<'missing' | 'retry'>;

/** The address a track's preview plays from. */
export const previewSrc = (deezerId: number): string => `/api/preview/${deezerId}`;

/** A pause longer than this may have outlived the link (the route hands out links with 5 minutes or more left). */
export const RELOAD_AFTER_PAUSE_MS = 4 * 60_000;

const checkRoute: PreviewCheck = async (deezerId) => {
  try {
    // Not followed: a redirect (an opaque one) means Deezer has the preview and the load failed on the way.
    const res = await fetch(previewSrc(deezerId), { redirect: 'manual', cache: 'no-store' });
    return res.status === 404 || res.status === 400 ? 'missing' : 'retry';
  } catch {
    return 'retry';
  }
};

/** The page's shared element. In the page, with no controls, so it shows nothing; tests find it by the attribute. */
function pageAudio(): HTMLAudioElement {
  const audio = document.createElement('audio');
  audio.setAttribute('data-preview-audio', '');
  document.body.appendChild(audio);
  return audio;
}

const IDLE: PreviewSnapshot = { key: null, status: 'idle', missing: new Set() };

export interface PreviewPlayerOptions {
  /** Makes the element on the first tap; tests pass a fake. */
  makeAudio?: () => HTMLAudioElement;
  check?: PreviewCheck;
  now?: () => number;
}

export function createPreviewPlayer(opts: PreviewPlayerOptions = {}): PreviewPlayer {
  const makeAudio = opts.makeAudio ?? pageAudio;
  const check = opts.check ?? checkRoute;
  const now = opts.now ?? Date.now;
  let audio: HTMLAudioElement | null = null;
  let state = IDLE;
  /** The Deezer track of the row held. */
  let held: number | null = null;
  /** Numbers each play() and each load, so an answer to an older one changes nothing. */
  let turn = 0;
  let loads = 0;
  /** The held load has made a sound, so its preview exists: a later failure is the network or a link that ran out. */
  let sounded = false;
  let pausedAt = 0;
  /** The load whose failure was last reported: a failed load fires an error and rejects play(), and is asked about once. */
  let reported = -1;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<PreviewSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  /**
   * The held load failed. The button goes back to ▶ at once. When it never made a sound, the route is asked why, and
   * a track Deezer has no preview for is disabled for the visit; any other failure leaves ▶ ready for another tap.
   */
  const broke = (key: string, deezerId: number) => {
    if (state.key === key) set({ key: null, status: 'idle' });
    if (sounded || reported === loads) return;
    reported = loads;
    void check(deezerId).then((answer) => {
      if (answer === 'missing') set({ missing: new Set(state.missing).add(deezerId) });
    });
  };

  const element = (): HTMLAudioElement => {
    if (audio) return audio;
    const a = makeAudio();
    // Our tap's play, or a resume from outside the page (the lock screen, headphones). Not one we have paused since.
    a.addEventListener('playing', () => {
      if (a.paused || state.key === null) return;
      sounded = true;
      if (state.status === 'loading' || state.status === 'paused') set({ status: 'playing' });
    });
    // Paused by something other than our button: the phone's controls, a call, headphones unplugged, another app.
    a.addEventListener('pause', () => {
      if (!a.paused || a.ended) return;
      if (state.status === 'playing' || state.status === 'loading') {
        pausedAt = now();
        set({ status: 'paused' });
      }
    });
    a.addEventListener('ended', () => set({ key: null, status: 'idle' }));
    // A load that failed: no preview (404), Deezer down (502), the link's audio would not play, or the network. One
    // that fails while paused is reloaded by the next tap.
    a.addEventListener('error', () => {
      if (state.key !== null && held !== null && (state.status === 'loading' || state.status === 'playing')) broke(state.key, held);
    });
    audio = a;
    return a;
  };

  const play = (a: HTMLAudioElement, key: string, deezerId: number) => {
    const mine = ++turn;
    held = deezerId;
    set({ key, status: 'loading' });
    let started: Promise<void> | undefined;
    try {
      started = a.play();
    } catch (err) {
      started = Promise.reject(err);
    }
    started?.then(
      () => {
        if (mine !== turn || state.key !== key || state.status !== 'loading') return;
        sounded = true;
        set({ status: 'playing' });
      },
      (err: unknown) => {
        if (mine !== turn) return; // a later tap took over
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'AbortError') return; // a pause cut it short: our tap or the pause handler set the state
        if (name === 'NotAllowedError') {
          // The browser did not count this as a tap. The button goes back to ▶, ready for one.
          if (state.key === key) set({ key: null, status: 'idle' });
          return;
        }
        broke(key, deezerId);
      },
    );
  };

  /** Loads the track's preview afresh (inside the tap, as iOS needs) and plays it, from `at` seconds when given. */
  const start = (a: HTMLAudioElement, key: string, deezerId: number, at = 0) => {
    a.src = previewSrc(deezerId);
    sounded = false;
    const load = ++loads;
    if (at > 0) {
      a.addEventListener(
        'loadedmetadata',
        () => {
          if (load === loads) a.currentTime = at;
        },
        { once: true },
      );
    }
    play(a, key, deezerId);
  };

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle(key, deezerId) {
      if (state.missing.has(deezerId)) return;
      const a = element();
      if (state.key === key && state.status !== 'idle') {
        if (state.status !== 'paused') {
          turn++; // a play() still starting is answered by this pause
          a.pause();
          pausedAt = now();
          set({ status: 'paused' });
          return;
        }
        // Resume where it stopped. A load that failed while paused, or a pause long enough for the link to have run
        // out, starts again from a fresh link at the same spot.
        if (a.error || now() - pausedAt > RELOAD_AFTER_PAUSE_MS) return start(a, key, deezerId, a.currentTime);
        return play(a, key, deezerId);
      }
      start(a, key, deezerId);
    },
    release(key) {
      if (state.key !== key || !audio) return;
      turn++;
      loads++;
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // drops the download as well
      sounded = false;
      held = null;
      set({ key: null, status: 'idle' });
    },
    progress() {
      if (!audio || state.key === null) return 0;
      const d = audio.duration;
      return d > 0 && Number.isFinite(d) ? Math.min(1, Math.max(0, audio.currentTime / d)) : 0;
    },
  };
}
