// Tempo per song (QWW-40). Three sources, kept raw per song in song_tempo and combined at read
// time, so changing the rule needs no refetch:
//   - Deezer's `bpm` (median over the matching studio versions we looked at),
//   - a beat tracker run on the 30 s Deezer preview (scripts/tempo-tracker.py; no audio is kept),
//   - UltraStar's `#BPM`, the note grid's tempo (a beat is four grid steps, so /4, and often double
//     or half the song's), read from note files by scripts/tempo-ultrastar.ts.
// Every tempo is folded into the 70 to 180 range, since each source mistakes a song for double or
// half its speed now and then and a singer feels a song's pulse in that range.
// Spotify is not a source: its audio features are closed to new apps (Nov 2024).

export const TEMPO_MIN = 70;
export const TEMPO_MAX = 180;

/** `bpm` doubled or halved until it is in [TEMPO_MIN, TEMPO_MAX); null when it is not a real tempo. */
export function foldBpm(bpm: number | null | undefined): number | null {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) return null;
  let t = bpm;
  while (t >= TEMPO_MAX) t /= 2;
  while (t < TEMPO_MIN) t *= 2;
  return t;
}

/** UltraStar's #BPM as the song's tempo: the grid has four steps to a beat. */
export const ultrastarTempo = (bpm: number | null | undefined): number | null => (bpm ? foldBpm(bpm / 4) : null);

const VERSION_TAGS =
  /\b(live|acoustic|remix|remixed|karaoke|instrumental|sped up|speed up|slowed|reverb|nightcore|cover|demo|unplugged|stripped|session|medley|reprise|a cappella|acapella)\b/i;
/** Tags that still leave the studio recording: "Remastered 2011", "Mono", "Single Version", "Album Version". ("Version", "Edit" and "Mix" alone are not version tags: "Glee Cast Version", "Radio Edit".) */
const HARMLESS = /\b(remaster(ed)?( \d{4})?|\d{4} remaster(ed)?|mono|stereo|single version|album version|original version|deluxe|bonus track)\b/gi;

/**
 * True for a title that is probably the song as released: no live, acoustic, remix, karaoke or
 * sped-up tag. A tag word the song's own title has ("Live and Let Die", "Cover Me") does not count.
 */
export function isStudioVersion(title: string, songTitle = ''): boolean {
  // Each tag word the song's title has can be spent once: "Live Forever (Live)" still has a tag.
  const own = new Map<string, number>();
  for (const w of songTitle.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) own.set(w, (own.get(w) ?? 0) + 1);
  for (const m of title.replace(HARMLESS, ' ').matchAll(new RegExp(VERSION_TAGS.source, 'gi'))) {
    for (const w of m[0].toLowerCase().split(' ')) {
      const left = own.get(w) ?? 0;
      if (!left) return false;
      own.set(w, left - 1);
    }
  }
  return true;
}

const OFF_TEMPO_TAGS = /\b(remix|remixed|karaoke|instrumental|sped up|speed up|slowed|reverb|nightcore|medley|a cappella|acapella)\b/i;

/**
 * A last resort for a song with no studio version on Deezer: a live, acoustic or demo take keeps
 * about the song's tempo, a remix, sped-up or karaoke version does not.
 */
export function isSameTempoVersion(title: string, songTitle = ''): boolean {
  const own = (songTitle.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
  const offending = title.replace(HARMLESS, ' ').match(new RegExp(OFF_TEMPO_TAGS.source, 'gi')) ?? [];
  return offending.every((w) => own.includes(w.toLowerCase()));
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Deezer's bpm over the versions looked at: each folded, then the median. Deezer sends 0 for unknown. */
export function deezerTempo(bpms: (number | null | undefined)[]): number | null {
  return median(bpms.map(foldBpm).filter((t): t is number => t !== null));
}

export type TempoSource = 'deezer' | 'tracker' | 'ultrastar';

/** What song_tempo keeps for a song: each source as measured (folded for Deezer's median), unset when it has none. */
export interface SongTempoRecord {
  key: string;
  deezerBpm?: number;
  /** Versions of the song Deezer's median was taken over. */
  deezerVersions?: number;
  trackerBpm?: number;
  /** UltraStar #BPM as written in the note file (not yet divided by 4). */
  ultrastarBpm?: number;
  /** The preview the tracker read, when it ran. */
  previewUrl?: string;
  /** When Deezer was last asked; a rerun skips songs checked recently. */
  checkedAt?: string;
}

/** Two tempos agree when within this share of each other. */
const AGREE = 0.06;
const agree = (a: number, b: number) => Math.abs(a - b) / Math.max(a, b) <= AGREE;

/**
 * The song's one tempo, with the source that supplied it. Deezer wins when it has one; the tracker
 * stands in when Deezer has none. UltraStar is the last resort, and also the tie-breaker: when
 * Deezer and the tracker disagree, the one UltraStar's tempo agrees with wins (the grid's double or
 * half is folded into range like every tempo, so 2:1 counts as agreeing; 4:3 does not); with no
 * UltraStar tempo, Deezer.
 */
export function combineTempo(r: Pick<SongTempoRecord, 'deezerBpm' | 'trackerBpm' | 'ultrastarBpm'>): { tempo: number; source: TempoSource } | null {
  const deezer = foldBpm(r.deezerBpm);
  const tracker = foldBpm(r.trackerBpm);
  const grid = ultrastarTempo(r.ultrastarBpm);
  if (deezer !== null && tracker !== null && !agree(deezer, tracker) && grid !== null) {
    if (agree(tracker, grid) && !agree(deezer, grid)) return { tempo: tracker, source: 'tracker' };
  }
  if (deezer !== null) return { tempo: deezer, source: 'deezer' };
  if (tracker !== null) return { tempo: tracker, source: 'tracker' };
  if (grid !== null) return { tempo: grid, source: 'ultrastar' };
  return null;
}

/** The tempo to sort by, or undefined when no source has one. */
export const tempoOf = (r: Pick<SongTempoRecord, 'deezerBpm' | 'trackerBpm' | 'ultrastarBpm'> | undefined): number | undefined =>
  r ? (combineTempo(r)?.tempo ?? undefined) : undefined;
