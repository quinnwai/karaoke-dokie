// One <audio> element plays every row's 30 s Deezer preview (QWW-48), so only one song plays at a time and a tap on
// another row switches at once. The element's address is GET /api/preview/<deezerId>, which redirects to the
// preview (server/preview.ts), so a tap sets it and calls play() in the same tick: iOS plays audio only when it is
// started inside the tap. No React here; PreviewButton.tsx draws the state.
//
// The latest tap always wins. Each play() gets a turn number, and the answer to an older one (a load cut short by a
// newer tap rejects with AbortError) changes nothing, so five taps in five seconds end with the fifth song playing.

/** What one track's button shows. 'loading' is between the tap and the first sound. */
export type PreviewStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface PreviewSnapshot {
  /** The track the player holds (a Deezer track id), or null when it holds none. */
  id: string | null;
  status: PreviewStatus;
  /** Tracks whose preview failed to load since the page opened; their buttons stay disabled. */
  failed: ReadonlySet<string>;
}

export interface PreviewPlayer {
  snapshot(): PreviewSnapshot;
  subscribe(listener: () => void): () => void;
  /** Plays the track, or pauses or resumes it when it is the one held. Call it inside the tap's handler. */
  toggle(id: string): void;
  /** Stops the track when it is the one held: its row went away (the song page opened, or a filter took it off). */
  release(id: string): void;
  /** How far the held preview has played, 0 to 1. */
  progress(): number;
}

/** The address a track's preview plays from. */
export const previewSrc = (id: string): string => `/api/preview/${encodeURIComponent(id)}`;

/** The page's shared element. In the page, with no controls, so it shows nothing; tests find it by the attribute. */
function pageAudio(): HTMLAudioElement {
  const audio = document.createElement('audio');
  audio.setAttribute('data-preview-audio', '');
  document.body.appendChild(audio);
  return audio;
}

const IDLE: PreviewSnapshot = { id: null, status: 'idle', failed: new Set() };

/** A player whose element is made on the first tap (`makeAudio`; tests pass a fake). */
export function createPreviewPlayer(makeAudio: () => HTMLAudioElement = pageAudio): PreviewPlayer {
  let audio: HTMLAudioElement | null = null;
  let state = IDLE;
  let turn = 0;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<PreviewSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const fail = (id: string) => {
    const failed = new Set(state.failed).add(id);
    set(state.id === id ? { failed, id: null, status: 'idle' } : { failed });
  };

  const element = (): HTMLAudioElement => {
    if (audio) return audio;
    const a = makeAudio();
    a.addEventListener('playing', () => {
      if (state.status === 'loading') set({ status: 'playing' });
    });
    // Paused by something other than our button: the phone's controls, headphones unplugged, another app's sound.
    a.addEventListener('pause', () => {
      if (state.status === 'playing' && a.paused && !a.ended) set({ status: 'paused' });
    });
    a.addEventListener('ended', () => set({ id: null, status: 'idle' }));
    // A load that failed: no preview (404), Deezer down (502), or the link's audio would not play.
    a.addEventListener('error', () => {
      if (state.id !== null && (state.status === 'loading' || state.status === 'playing')) fail(state.id);
    });
    audio = a;
    return a;
  };

  const play = (a: HTMLAudioElement, id: string) => {
    const mine = ++turn;
    set({ id, status: 'loading' });
    let started: Promise<void> | undefined;
    try {
      started = a.play();
    } catch (err) {
      started = Promise.reject(err);
    }
    started?.then(
      () => {
        if (mine === turn && state.id === id && state.status === 'loading') set({ status: 'playing' });
      },
      (err: unknown) => {
        if (mine !== turn) return; // a later tap took over
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'AbortError') return; // paused before it started; the pause set the state
        if (name === 'NotAllowedError') {
          // The browser did not count this as a tap. The button goes back to ▶, ready for one.
          if (state.id === id) set({ id: null, status: 'idle' });
          return;
        }
        fail(id);
      },
    );
  };

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    toggle(id) {
      if (state.failed.has(id)) return;
      const a = element();
      if (state.id === id && state.status !== 'idle') {
        if (state.status === 'paused') return play(a, id); // resume where it stopped
        turn++; // a play() still starting is answered by this pause
        a.pause();
        set({ status: 'paused' });
        return;
      }
      a.src = previewSrc(id); // inside the tap, before play(): iOS needs both there
      play(a, id);
    },
    release(id) {
      if (state.id !== id || !audio) return;
      turn++;
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // drops the download as well
      set({ id: null, status: 'idle' });
    },
    progress() {
      if (!audio || state.id === null) return 0;
      const d = audio.duration;
      return d > 0 && Number.isFinite(d) ? Math.min(1, Math.max(0, audio.currentTime / d)) : 0;
    },
  };
}
