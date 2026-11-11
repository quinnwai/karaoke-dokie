// The gear art (Round 6A §6 to §9): the neon tubes on each gear's strip, the simplified icon on its tab, the Era tab's
// jukebox, and the icon on each era button. The geometry is copied from docs/setlist-round6a/setlist-round6a.html, and
// tests/setlist/gearArt.test.tsx checks it against that file, element by element.
//
// What moves with a value, what an off gear looks like, which notes, bolts and rays are lit and which jukebox lights are on
// come from src/lib/setlist/art.ts; this file only applies it. Presentational, but for the one thing a strip's root keeps: whether
// its turn-on flicker is due (StripSvg). The parent sizes the strip art and draws the box behind it (the svg has no background,
// width or height of its own), and passes the gear's default as `value` while it is off.

import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import {
  AMBER,
  CYAN,
  FLICKER_MS,
  PINK,
  TAB_GLOW_DEVIATION,
  VIOLET,
  flickerSession,
  itemArt,
  jukeboxArt,
  laneArt,
  metronome,
  neonFlicker,
  noteColor,
  tabGlow,
  tube,
} from '../../lib/setlist/art';
import type { EraId, GearId } from '../../lib/setlist/types';
import styles from './GearArt.module.css';

/** `strip` is the 150x80 art on a gear's strip; `tab` is the simplified 34x27 icon on its tab (§9). */
export type GearArtVariant = 'strip' | 'tab';

export interface GearArtProps {
  gear: GearId;
  variant: GearArtVariant;
  /** The 0 to 100 value to draw. While the gear is off this is its default. */
  value: number;
  /** The gear is off (reset, not factored in): it is drawn as unlit tubes, the metronome still, no flicker (§7). */
  off: boolean;
  /** For the parent: the strip art's size, corner radius and the box behind it. The tab icon brings its own size. */
  className?: string;
}

interface ArtProps {
  value: number;
  off: boolean;
  className?: string;
}

/** The art's own class first, then the parent's. */
const rootClass = (own: string | undefined, parent: string | undefined) => [own, parent].filter(Boolean).join(' ');

/**
 * An id for this instance's glow filter. A screen draws four strips at once, and with one id repeated every `url(#id)`
 * would use the first filter of that name. React 19's ids (`_R_1_`) are plain enough for `url(#...)`; the test checks it.
 */
function useFilterId(): string {
  return `neon-${useId()}`;
}

/**
 * The glow every strip shares (§6): the shape blurred (stdDeviation 2), with the sharp shape merged on top. The region is a
 * little larger than the art so the blur is not clipped; how much taller depends on the art, as in the reference.
 */
function Glow({ id, y, height }: { id: string; y: string; height: string }) {
  return (
    <defs>
      <filter id={id} x="-20%" y={y} width="140%" height={height}>
        <feGaussianBlur stdDeviation="2" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

/**
 * The strip art's root. The flicker is an inline style so that it restarts exactly when the gear goes from off to on, when
 * its value changes from `none`; a change of the gear's own value leaves it alone (§7). The `flick` class is only the hook
 * the reduced-motion rule needs to switch it off.
 *
 * It plays on first load and when the gear goes from off to on, and not when the strip is shown again. The mini sheet keeps
 * all four strips mounted and hides three (`display: none`), and a browser plays an animation again each time its element is
 * shown, so a style that stayed set would flicker the art on every tab switch and every expand. So the style is only there
 * while the flicker is `armed`, and a timer takes it away when the flicker is over; not `animationend`, which a strip that was
 * hidden at first load never gets. Armed: from the start on the page's first load (every strip in its first commit), while the
 * gear is off (so its next turn-on plays), and for no longer than FLICKER_MS once the gear is on.
 */
function StripSvg({ off, className, children }: { off: boolean; className?: string; children: ReactNode }) {
  const [armed, setArmed] = useState(() => !flickerSession.done);
  if (off && !armed) setArmed(true);
  // After every art of the first commit has read the flag, and in an effect: render may run twice before anything commits.
  useEffect(() => {
    flickerSession.done = true;
  }, []);
  const flickering = armed && !off;
  useEffect(() => {
    if (!flickering) return;
    const over = setTimeout(() => setArmed(false), FLICKER_MS);
    return () => clearTimeout(over);
  }, [flickering]);
  return (
    <svg
      viewBox="0 0 150 80"
      aria-hidden="true"
      className={rootClass(styles.flick, className)}
      style={{ animation: neonFlicker(off, armed) }}
    >
      {children}
    </svg>
  );
}

/** What every tab icon shares: 34x27 on screen, drawn on a 28x22 grid (§9). */
const TAB = { width: '34', height: '27', viewBox: '0 0 28 22', fill: 'none', 'aria-hidden': 'true' } as const;

/**
 * The glow of a History or Popularity tab icon (§7, §9; QWW-57, R7): the gear's colour, blurred by the same 3 px as the other
 * tabs' CSS glow, behind the group that names this filter and merged with it. A CSS filter on the svg would light the unlit rays
 * too, and WebKit does not draw one on an svg child reliably. It works in sRGB, as CSS filters do. Its region is in the grid's
 * units, the grid and 8 round it (three standard deviations is 7.4): a region taken from the group's own box would be empty for a
 * lone straight ray and would change as rays light.
 */
function TabGlow({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <filter id={id} x="-8" y="-8" width="44" height="38" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceAlpha" stdDeviation={TAB_GLOW_DEVIATION} result="b" />
        <feFlood floodColor={color} />
        <feComposite in2="b" operator="in" result="glow" />
        <feMerge>
          <feMergeNode in="glow" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

interface TabRay {
  d: string;
  /** Its place among the seven: ray i mirrors note or bolt i. */
  i: number;
  lit: boolean;
  /** Its colour while it is lit, UNLIT otherwise (itemArt). */
  color: string;
}

/**
 * A History or Popularity tab icon: a body (the headphones, the mic) and seven rays. The glow reaches only what is lit: the body
 * while the gear is on and the rays the value reaches are in the one group that names the glow filter, the unlit rays come after
 * it with no filter on them or above them, and an off gear has no filter at all. A ray's threshold rises with its index, so the lit
 * ones are the first ones and the rays stay in index order in the document, as they are in the reference.
 */
function RayTab({
  off,
  className,
  glow,
  body,
  rays,
}: {
  off: boolean;
  className?: string;
  /** The gear's colour, which is the glow's whatever the colour of the part it surrounds. */
  glow: string;
  body: ReactNode;
  rays: readonly TabRay[];
}) {
  const id = useFilterId();
  const ray = ({ d, i, lit, color }: TabRay) => <path key={d} data-ray="" data-i={i} data-lit={lit} d={d} stroke={color} />;
  return (
    // `overflow`: the glow reaches past the 34x27 box, as the CSS filter on this svg did; the box would clip a filter inside it.
    <svg {...TAB} overflow="visible" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {!off && <TabGlow id={id} color={glow} />}
      <g filter={off ? undefined : `url(#${id})`}>
        {body}
        <g strokeWidth="1.5">{rays.filter((r) => r.lit).map(ray)}</g>
      </g>
      <g strokeWidth="1.5">{rays.filter((r) => !r.lit).map(ray)}</g>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Difficulty: a pitch lane. The band and the dashes take their height, position and colour from laneArt(value, off).

/** The seven dashes: x1 and x2. Their y comes from the value. */
const DASHES = [
  ['9', '22'],
  ['30', '36'],
  ['46', '62'],
  ['71', '77'],
  ['87', '97'],
  ['107', '115'],
  ['125', '141'],
] as const;

const GRID_Y = ['12', '26', '40', '54', '68'] as const;

function DifficultyStrip({ value, off, className }: ArtProps) {
  const glow = useFilterId();
  const lane = laneArt(value, off);
  return (
    <StripSvg off={off} className={className}>
      <Glow id={glow} y="-40%" height="180%" />
      <g stroke="#1F1D26" strokeWidth="1">
        {GRID_Y.map((y) => (
          <line key={y} x1="0" y1={y} x2="150" y2={y} />
        ))}
      </g>
      <rect x="0" y={lane.bandY} width="150" height={lane.bandH} fill={lane.color} fillOpacity={lane.bandOpacity} />
      <g filter={`url(#${glow})`} strokeWidth="5" strokeLinecap="round" stroke={lane.color}>
        {DASHES.map(([x1, x2], i) => (
          <line key={x1} x1={x1} x2={x2} y1={lane.dashY[i]} y2={lane.dashY[i]} />
        ))}
      </g>
    </StripSvg>
  );
}

/** Three dashes; the colour follows the tier. The icon is drawn in `currentColor`, so the tier colour is its `color`. */
function DifficultyTab({ value, off, className }: ArtProps) {
  const lane = laneArt(value, off);
  return (
    <svg
      {...TAB}
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      className={className}
      style={{ color: lane.color, filter: tabGlow(lane.color, off) }}
    >
      <path d="M4 15 H9 M12 8 H17 M20 12 H25" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// History: headphones and seven notes. Note i is lit once the value reaches its threshold, and drawn unlit until then (itemArt).

interface Note {
  transform: string;
  /** Two notes joined by a beam, not one note with a flag. */
  beamed?: true;
  /** When this note's bob starts, so the notes do not move in step. */
  delay?: string;
}

const NOTES: readonly Note[] = [
  { transform: 'translate(24 38) rotate(-10)' },
  { transform: 'translate(126 36) rotate(10)', delay: '0.2s' },
  { transform: 'translate(12 66) rotate(-14) scale(1.1)', beamed: true, delay: '0.4s' },
  { transform: 'translate(132 64) rotate(12) scale(1.05)', delay: '0.1s' },
  { transform: 'translate(52 14) rotate(-8) scale(0.85)', delay: '0.3s' },
  { transform: 'translate(100 12) rotate(8) scale(0.85)', delay: '0.5s' },
  { transform: 'translate(8 22) rotate(-18) scale(0.9)', delay: '0.6s' },
];

// The note shapes, filled with the note's colour by the group around them.
const NOTE = (
  <>
    <ellipse rx="3.4" ry="2.6" transform="rotate(-20)" />
    <rect x="2.3" y="-12" width="1.3" height="12" />
    <path d="M3.6 -12 q4 1.5 4.2 5.5 q-1.2 -2.6 -4.2 -2.8 Z" />
  </>
);

const BEAMED = (
  <>
    <ellipse rx="3.4" ry="2.6" transform="rotate(-20)" />
    <ellipse cx="9" cy="-2" rx="3.4" ry="2.6" transform="rotate(-20 9 -2)" />
    <rect x="2.3" y="-12" width="1.3" height="12" />
    <rect x="11.3" y="-14" width="1.3" height="12" />
    <polygon points="2.3,-12 12.6,-14 12.6,-11 2.3,-9" />
  </>
);

function HistoryStrip({ value, off, className }: ArtProps) {
  const glow = useFilterId();
  const headphones = tube(CYAN, off);
  return (
    <StripSvg off={off} className={className}>
      <Glow id={glow} y="-30%" height="160%" />
      <g filter={`url(#${glow})`} strokeLinecap="round" strokeLinejoin="round">
        {/* The headband arcs over and drops onto the top of each muff; it never crosses into one. */}
        <path d="M47.3 46 V40 A28.4 28.4 0 0 1 102.7 40 V46" fill="none" strokeWidth="3" stroke={headphones} />
        <g transform="rotate(-7 49 60)" fill="none" stroke={headphones}>
          <rect x="41" y="46" width="16" height="28" rx="8" strokeWidth="2.4" />
          <path d="M46 61 Q45.4 64 46 67" strokeWidth="1.4" />
        </g>
        <g transform="rotate(7 101 60)" fill="none" stroke={headphones}>
          <rect x="93" y="46" width="16" height="28" rx="8" strokeWidth="2.4" />
        </g>
        {NOTES.map((note, i) => {
          const { lit, color } = itemArt(noteColor(i), value, i, off);
          return (
            <g key={note.transform} className={styles.fade} data-note="" data-i={i} data-lit={lit} transform={note.transform}>
              <g className={styles.bob} fill={color} style={note.delay ? { animationDelay: note.delay } : undefined}>
                {note.beamed ? BEAMED : NOTE}
              </g>
            </g>
          );
        })}
      </g>
    </StripSvg>
  );
}

/** Where ray i sits around the headphones: ray i mirrors note i, in the note's colour and lit on the note's threshold. */
const HISTORY_RAYS = [
  'M6.1 9.3 L3.9 8.9',
  'M21.9 9 L24 8.6',
  'M3.9 13.6 L1.8 14.2',
  'M23.1 13.4 L25.2 14',
  'M9.4 4.1 L8.1 2.3',
  'M18.7 4.1 L20 2.4',
  'M4.6 3.9 L3.1 2.9',
] as const;

function HistoryTab({ value, off, className }: ArtProps) {
  return (
    <RayTab
      off={off}
      className={className}
      glow={CYAN}
      body={
        <g strokeWidth="1.5" stroke={tube(CYAN, off)}>
          <path d="M10.2 12.2 V10 A3.8 3.8 0 0 1 17.8 10 V12.2" />
          <rect x="8.9" y="12.2" width="3.2" height="5.6" rx="1.6" transform="rotate(-7 10.5 15)" />
          <rect x="15.9" y="12.2" width="3.2" height="5.6" rx="1.6" transform="rotate(7 17.5 15)" />
        </g>
      }
      rays={HISTORY_RAYS.map((d, i) => ({ d, i, ...itemArt(noteColor(i), value, i, off) }))}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Popularity: a microphone and seven bolts, lit on the same thresholds as the notes.

const BOLT_PATH = 'M2 -8 L-3 1 L0 1 L-2 8 L3 -1 L0 -1 Z';

interface Bolt {
  transform: string;
  /** When this bolt's bob starts. */
  delay?: string;
}

const BOLTS: readonly Bolt[] = [
  { transform: 'translate(75 14) scale(1.25)' },
  { transform: 'translate(100 18.8) rotate(44.8) scale(1.1)', delay: '0.1s' },
  { transform: 'translate(50 18.8) rotate(-44.8) scale(1.1)', delay: '0.2s' },
  { transform: 'translate(117 31.8) rotate(73.8) scale(1.2)', delay: '0.3s' },
  { transform: 'translate(33 31.8) rotate(-73.8) scale(1.2)', delay: '0.4s' },
  { transform: 'translate(120.3 49.2) rotate(96.5) scale(1.05)', delay: '0.5s' },
  { transform: 'translate(29.7 49.2) rotate(-96.5) scale(1.05)', delay: '0.6s' },
];

function PopularityStrip({ value, off, className }: ArtProps) {
  const glow = useFilterId();
  return (
    <StripSvg off={off} className={className}>
      <Glow id={glow} y="-30%" height="160%" />
      <g filter={`url(#${glow})`} fill="none" strokeLinecap="round" strokeLinejoin="round">
        <g transform="translate(75 44) rotate(-16)" strokeWidth="2.4" stroke={tube(PINK, off)}>
          <circle r="12" />
          <path d="M-12 0 H12" strokeWidth="1.6" />
          <ellipse rx="5" ry="12" strokeWidth="1.4" />
          <path d="M-8 14 H8 L6 20 H-6 Z" />
          <path d="M-4.5 22 L-3 42 H3 L4.5 22" />
        </g>
        {BOLTS.map((b, i) => {
          const { lit, color } = itemArt(AMBER, value, i, off);
          return (
            <g key={b.transform} className={styles.fade} data-bolt="" data-i={i} data-lit={lit} transform={b.transform}>
              <path className={styles.bob} style={b.delay ? { animationDelay: b.delay } : undefined} d={BOLT_PATH} fill={color} />
            </g>
          );
        })}
      </g>
    </StripSvg>
  );
}

/** Where ray i sits around the mic: ray i mirrors bolt i, in amber and lit on the bolt's threshold. */
const POPULARITY_RAYS = [
  'M13.7 3.4 V1.3',
  'M17 4.3 L18.1 2.4',
  'M10.4 4.3 L9.3 2.4',
  'M19.4 6.7 L21.3 5.6',
  'M8 6.7 L6.1 5.6',
  'M20.3 10 H22.5',
  'M7.1 10 H4.9',
] as const;

function PopularityTab({ value, off, className }: ArtProps) {
  return (
    <RayTab
      off={off}
      className={className}
      glow={AMBER}
      body={
        <g transform="rotate(-16 14 11)" strokeWidth="1.4" stroke={tube(PINK, off)}>
          <circle cx="14" cy="10" r="3.4" />
          <path d="M10.6 10 H17.4" strokeWidth="1" />
          <path d="M11.9 14.4 H16.1 L15.4 21 H12.6 Z" />
        </g>
      }
      rays={POPULARITY_RAYS.map((d, i) => ({ d, i, ...itemArt(AMBER, value, i, off) }))}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Tempo: a metronome. The pendulum swings at the speed and width metronome(value) gives, and its weight slides down.
// An off metronome is unlit and still.

function TempoStrip({ value, off, className }: ArtProps) {
  const glow = useFilterId();
  const pendulum = metronome(value, off);
  return (
    <StripSvg off={off} className={className}>
      <Glow id={glow} y="-20%" height="140%" />
      <g filter={`url(#${glow})`} fill="none" strokeLinecap="round" strokeLinejoin="round" stroke={pendulum.color}>
        <path d="M65 10 H85 L104 76 H46 Z" strokeWidth="2.4" />
        <path d="M70 10 L75 5 L80 10" strokeWidth="2" />
        <path d="M53 56 H97" strokeWidth="1.8" />
        <path d="M101.5 64 H107" strokeWidth="1.8" />
        <circle cx="110.5" cy="64" r="3.5" strokeWidth="1.8" />
        <g className={styles.pend} data-pendulum="" style={{ animation: pendulum.animation }}>
          <path d="M75 56 V16" strokeWidth="2" />
          <rect data-weight="" x="69" y={pendulum.weightY} width="12" height="7" rx="2" strokeWidth="1.8" />
        </g>
      </g>
    </StripSvg>
  );
}

function TempoTab({ value, off, className }: ArtProps) {
  const pendulum = metronome(value, off);
  return (
    <svg
      {...TAB}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke={pendulum.color}
      className={className}
      style={{ filter: tabGlow(VIOLET, off) }}
    >
      <path d="M11 3 H17 L22 20 H6 Z" />
      <path d="M8.2 15.5 H19.8" strokeWidth="1.2" />
      <g className={styles.pendTab} data-pendulum="" style={{ animation: pendulum.animation }}>
        <path d="M14 15.5 V5" />
        <rect data-weight="" x="12.4" y={pendulum.tabWeightY} width="3.2" height="2.2" rx="0.6" strokeWidth="1.1" />
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

const ART: Record<GearId, Record<GearArtVariant, (props: ArtProps) => ReactElement>> = {
  difficulty: { strip: DifficultyStrip, tab: DifficultyTab },
  history: { strip: HistoryStrip, tab: HistoryTab },
  popularity: { strip: PopularityStrip, tab: PopularityTab },
  tempo: { strip: TempoStrip, tab: TempoTab },
};

/**
 * A gear's illustration at `value` (0 to 100), decorative (`aria-hidden`). The strip art is one svg on a 150x80 viewBox
 * that flickers on when its gear is turned on; the tab icon is a simpler one on a 28x22 viewBox. A gear that is off is
 * drawn at its default value in unlit tubes, so the caller passes that default as `value`.
 */
export function GearArt({ gear, variant, value, off, className }: GearArtProps) {
  const Art = ART[gear][variant];
  return <Art value={value} off={off} className={className} />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Era

interface EraTabArtProps {
  /** The picked eras: how many are picked decides which jukebox lights are on. */
  eras: readonly EraId[];
  off: boolean;
  className?: string;
}

/** The Era tab's art: a jukebox (§9) with a light for the first era picked and one for the second, pink while Era is on. */
export function EraTabArt({ eras, off, className }: EraTabArtProps) {
  const jukebox = jukeboxArt(eras.length, off);
  return (
    <svg
      {...TAB}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      stroke={jukebox.body}
      className={className}
      style={{ filter: tabGlow(PINK, off) }}
    >
      <path data-jukebox="body" d="M3 21 V10.8 A11 8.3 0 0 1 25 10.8 V21 Z" />
      <path d="M6.2 14.6 V10.8 A7.8 5.75 0 0 1 21.8 10.8 V14.6 Z" strokeWidth="1.1" />
      <path d="M10.1 7 V14.6 M14 5.1 V14.6 M17.9 7 V14.6" strokeWidth="0.8" />
      <circle data-jukebox="button" data-i="0" cx="10.5" cy="17.8" r="1.7" stroke="none" fill={jukebox.lights[0]} />
      <circle data-jukebox="button" data-i="1" cx="17.5" cy="17.8" r="1.7" stroke="none" fill={jukebox.lights[1]} />
    </svg>
  );
}

/** What every era icon shares: 22x22 on screen, drawn on a 30x30 grid in the button's text colour. */
const ICON = {
  width: '22',
  height: '22',
  viewBox: '0 0 30 30',
  fill: 'none',
  stroke: 'currentColor',
  'aria-hidden': 'true',
} as const;

const ERA_ICONS: Record<EraId, ReactElement> = {
  pre: (
    <svg {...ICON} strokeWidth="1.6">
      <circle cx="15" cy="15" r="12.5" />
      <circle cx="15" cy="15" r="8.5" strokeWidth="0.9" />
      <circle cx="15" cy="15" r="4.6" />
    </svg>
  ),
  s70: (
    <svg {...ICON} strokeWidth="1.6">
      <rect x="3" y="6" width="24" height="18" rx="2" />
      <circle cx="13" cy="15" r="6.2" />
      <circle cx="13" cy="15" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="23" cy="9.5" r="1.3" fill="currentColor" stroke="none" />
      <path d="M23 9.5 V16.5 L17.5 19.5" />
    </svg>
  ),
  s80: (
    <svg {...ICON} strokeWidth="1.6">
      <rect x="2.5" y="6" width="25" height="18" rx="2" />
      <path d="M6.5 9 H23.5 L25 10.5 V18 H5 V10.5 Z" strokeWidth="1" />
      <rect x="9" y="11.2" width="12" height="4.6" rx="2.3" strokeWidth="1" />
      <circle cx="11.4" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18.6" cy="13.5" r="1.2" fill="currentColor" stroke="none" />
      <path d="M9.5 24 L11 20.5 H19 L20.5 24" strokeWidth="1" />
    </svg>
  ),
  s90: (
    <svg {...ICON} strokeWidth="1.6">
      <circle cx="15" cy="15" r="12.5" />
      <circle cx="15" cy="15" r="2.6" />
      <path d="M15 6.5 A8.5 8.5 0 0 1 23.5 15" />
      <path d="M6.5 15 A8.5 8.5 0 0 0 15 23.5" />
    </svg>
  ),
  s00: (
    <svg {...ICON} strokeWidth="1.6">
      <rect x="3" y="10" width="24" height="10" rx="2.5" />
      <rect x="6" y="12.5" width="9" height="5" fill="currentColor" stroke="none" />
      <circle cx="19.5" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="23" cy="15" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  s10: (
    <svg {...ICON} strokeWidth="1.6">
      <rect x="8.5" y="3" width="13" height="24" rx="2.5" />
      <path d="M13 11 L19 15 L13 19 Z" fill="currentColor" stroke="none" />
    </svg>
  ),
  s20: (
    <svg {...ICON} strokeWidth="2.4" strokeLinecap="round">
      <line x1="5" y1="11" x2="5" y2="19" />
      <line x1="10" y1="7" x2="10" y2="23" />
      <line x1="15" y1="3" x2="15" y2="27" />
      <line x1="20" y1="8" x2="20" y2="22" />
      <line x1="25" y1="12" x2="25" y2="18" />
    </svg>
  ),
};

/**
 * The neon outline inside an era button, one per era (§8). It is drawn in the button's text colour; the button's CSS also
 * gives it the lit glow, so nothing here depends on the era being picked.
 */
export function EraIcon({ era }: { era: EraId }) {
  return ERA_ICONS[era];
}
