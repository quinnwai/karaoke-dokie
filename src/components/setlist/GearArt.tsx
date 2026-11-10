// The gear art (spec §6): the illustration on each gear's strip and its smaller copy on the gear's tab, the Era tab's
// art, and the icon on each era button. The geometry is copied from docs/setlist-round5/setlist-round5.html, and
// tests/setlist/gearArt.test.tsx checks it against that file, element by element.
//
// What moves with a value comes from src/lib/setlist/art.ts; this file only applies it. Presentational: no state, no
// effects. The parent sets the size and the corner radius, and dims the art when its gear is off (it then passes the
// gear's default as `value`, and a className that carries the dimming).

import type { ReactElement } from 'react';
import { itemOpacity, laneArt, metronome } from '../../lib/setlist/art';
import { ERA_IDS, type EraId, type GearId } from '../../lib/setlist/types';
import styles from './GearArt.module.css';

/** `strip` is the 150x80 art in a gear's strip (shown at 120x64, or 150x80 in the mini sheet); `tab` is the small copy. */
export type GearArtVariant = 'strip' | 'tab';

export interface GearArtProps {
  gear: GearId;
  variant: GearArtVariant;
  /** The 0 to 100 value to draw. */
  value: number;
  /** For the parent: the svg's size, its corner radius and the off-state dimming. */
  className?: string;
}

interface ArtProps {
  value: number;
  className?: string;
}

/** The art's own background class first, then the parent's. */
const rootClass = (background: string | undefined, parent: string | undefined) =>
  [background, parent].filter(Boolean).join(' ') || undefined;

// ---------------------------------------------------------------------------------------------------------------------
// Difficulty: a pitch lane. The band and the dashes take their height, position and colour from laneArt(value).

/** The seven dashes: x and width. Their y comes from the value. */
const DASHES = [
  ['6', '18'],
  ['27', '12'],
  ['43', '22'],
  ['68', '12'],
  ['84', '16'],
  ['104', '14'],
  ['122', '22'],
] as const;

const GRID_Y = ['12', '26', '40', '54', '68'] as const;

function DifficultyStrip({ value, className }: ArtProps) {
  const lane = laneArt(value);
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artLane, className)}>
      <rect x="0" y={lane.bandY} width="150" height={lane.bandH} fill={lane.color} fillOpacity="0.2" />
      <g stroke="#3A3466" strokeWidth="1">
        {GRID_Y.map((y) => (
          <line key={y} x1="0" y1={y} x2="150" y2={y} />
        ))}
      </g>
      <g fill={lane.color}>
        {DASHES.map(([x, width], i) => (
          <rect key={x} data-i={i} x={x} y={lane.dashY[i]} width={width} height="6" rx="3" />
        ))}
      </g>
    </svg>
  );
}

function DifficultyTab({ value, className }: ArtProps) {
  const lane = laneArt(value);
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artLane, className)}>
      <rect x="0" y={lane.bandY} width="150" height={lane.bandH} fill={lane.color} fillOpacity="0.2" />
      <g fill={lane.color}>
        {DASHES.map(([x, width], i) => (
          <rect key={x} data-i={i} x={x} y={lane.dashY[i]} width={width} height="8" rx="4" />
        ))}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Listening history: headphones and seven notes. Note i is drawn once the value reaches its threshold (itemOpacity).

interface Note {
  transform: string;
  fill: string;
  /** Two notes joined by a beam, not one note with a flag. */
  beamed?: true;
  /** Strip only: when this note's bob starts, so the notes do not move in step. */
  delay?: string;
}

const STRIP_NOTES: readonly Note[] = [
  { transform: 'translate(33 38) rotate(-10)', fill: '#191714' },
  { transform: 'translate(118 38) rotate(10)', fill: '#A8283D', delay: '0.2s' },
  { transform: 'translate(22 64) rotate(-14) scale(1.1)', fill: '#A8283D', beamed: true, delay: '0.4s' },
  { transform: 'translate(126 58) rotate(12) scale(1.05)', fill: '#191714', delay: '0.1s' },
  { transform: 'translate(56 20) rotate(-8) scale(0.85)', fill: '#191714', delay: '0.3s' },
  { transform: 'translate(92 18) rotate(8) scale(0.85)', fill: '#A8283D', delay: '0.5s' },
  { transform: 'translate(10 40) rotate(-18) scale(0.9)', fill: '#191714', delay: '0.6s' },
];

const TAB_NOTES: readonly Note[] = [
  { transform: 'translate(30 40) rotate(-10) scale(1.6)', fill: '#191714' },
  { transform: 'translate(118 40) rotate(10) scale(1.6)', fill: '#A8283D' },
  { transform: 'translate(16 68) rotate(-14) scale(1.4)', fill: '#A8283D', beamed: true },
  { transform: 'translate(124 66) rotate(12) scale(1.6)', fill: '#191714' },
  { transform: 'translate(56 20) rotate(-8) scale(1.4)', fill: '#191714' },
  { transform: 'translate(93 19) rotate(8) scale(1.4)', fill: '#A8283D' },
  { transform: 'translate(8 38) rotate(-18) scale(1.4)', fill: '#191714' },
];

// The note shapes. The tab's stems are a little thicker than the strip's.
const STRIP_NOTE = (
  <>
    <ellipse rx="3.4" ry="2.6" transform="rotate(-20)" />
    <rect x="2.3" y="-12" width="1.3" height="12" />
    <path d="M3.6 -12 q4 1.5 4.2 5.5 q-1.2 -2.6 -4.2 -2.8 Z" />
  </>
);

const STRIP_BEAMED = (
  <>
    <ellipse rx="3.4" ry="2.6" transform="rotate(-20)" />
    <ellipse cx="9" cy="-2" rx="3.4" ry="2.6" transform="rotate(-20 9 -2)" />
    <rect x="2.3" y="-12" width="1.3" height="12" />
    <rect x="11.3" y="-14" width="1.3" height="12" />
    <polygon points="2.3,-12 12.6,-14 12.6,-11 2.3,-9" />
  </>
);

const TAB_NOTE = (
  <>
    <ellipse rx="3.4" ry="2.6" transform="rotate(-20)" />
    <rect x="2.1" y="-12" width="1.6" height="12" />
    <path d="M3.7 -12 q4 1.5 4.2 5.5 q-1.2 -2.6 -4.2 -2.8 Z" />
  </>
);

const TAB_BEAMED = (
  <>
    <ellipse rx="3.4" ry="2.6" transform="rotate(-20)" />
    <ellipse cx="9" cy="-2" rx="3.4" ry="2.6" transform="rotate(-20 9 -2)" />
    <rect x="2.1" y="-12" width="1.6" height="12" />
    <rect x="11.1" y="-14" width="1.6" height="12" />
    <polygon points="2.1,-12 12.7,-14 12.7,-10.8 2.1,-8.8" />
  </>
);

function HistoryStrip({ value, className }: ArtProps) {
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artCream, className)}>
      <path d="M49.3 50 A26 26 0 1 1 100.7 50" fill="none" stroke="#191714" strokeWidth="5" strokeLinecap="round" />
      <g transform="rotate(-7 49 60)">
        <rect x="41" y="46" width="16" height="28" rx="8" fill="#191714" />
        <rect x="54" y="49" width="6" height="22" rx="3" fill="#A8283D" />
        <rect x="45.5" y="61" width="3" height="7" rx="1.5" fill="#D9D3C4" />
      </g>
      <g transform="rotate(7 101 60)">
        <rect x="93" y="46" width="16" height="28" rx="8" fill="#191714" />
        <rect x="90" y="49" width="6" height="22" rx="3" fill="#A8283D" />
      </g>
      {STRIP_NOTES.map((note, i) => (
        <g
          key={note.transform}
          className={styles.histNote}
          data-i={i}
          transform={note.transform}
          style={{ opacity: itemOpacity(value, i) }}
        >
          <g className={styles.bob} fill={note.fill} style={note.delay ? { animationDelay: note.delay } : undefined}>
            {note.beamed ? STRIP_BEAMED : STRIP_NOTE}
          </g>
        </g>
      ))}
    </svg>
  );
}

function HistoryTab({ value, className }: ArtProps) {
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artCream, className)}>
      <path d="M49.3 50 A26 26 0 1 1 100.7 50" fill="none" stroke="#191714" strokeWidth="6" strokeLinecap="round" />
      <g transform="rotate(-7 49 60)">
        <rect x="41" y="46" width="16" height="28" rx="8" fill="#191714" />
        <rect x="54" y="49" width="6" height="22" rx="3" fill="#A8283D" />
      </g>
      <g transform="rotate(7 101 60)">
        <rect x="93" y="46" width="16" height="28" rx="8" fill="#191714" />
        <rect x="90" y="49" width="6" height="22" rx="3" fill="#A8283D" />
      </g>
      {TAB_NOTES.map((note, i) => (
        <g
          key={note.transform}
          className={styles.histNote}
          data-i={i}
          transform={note.transform}
          fill={note.fill}
          style={{ opacity: itemOpacity(value, i) }}
        >
          {note.beamed ? TAB_BEAMED : TAB_NOTE}
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Popularity: a microphone and seven bolts, drawn on the same thresholds as the notes.

const BOLT_PATH = 'M2 -8 L-3 1 L0 1 L-2 8 L3 -1 L0 -1 Z';

interface Bolt {
  transform: string;
  /** When this bolt's bob starts. */
  delay?: string;
}

const STRIP_BOLTS: readonly Bolt[] = [
  { transform: 'translate(75 14) scale(1.25)' },
  { transform: 'translate(100 18.8) rotate(44.8) scale(1.1)', delay: '0.1s' },
  { transform: 'translate(50 18.8) rotate(-44.8) scale(1.1)', delay: '0.2s' },
  { transform: 'translate(117 31.8) rotate(73.8) scale(1.2)', delay: '0.3s' },
  { transform: 'translate(33 31.8) rotate(-73.8) scale(1.2)', delay: '0.4s' },
  { transform: 'translate(120.3 49.2) rotate(96.5) scale(1.05)', delay: '0.5s' },
  { transform: 'translate(29.7 49.2) rotate(-96.5) scale(1.05)', delay: '0.6s' },
];

/** The tab's bolts sit where the strip's do, all at one larger size, and do not bob. */
const TAB_BOLTS = [
  'translate(75 14) scale(1.6)',
  'translate(100 18.8) rotate(44.8) scale(1.6)',
  'translate(50 18.8) rotate(-44.8) scale(1.6)',
  'translate(117 31.8) rotate(73.8) scale(1.6)',
  'translate(33 31.8) rotate(-73.8) scale(1.6)',
  'translate(120.3 49.2) rotate(96.5) scale(1.6)',
  'translate(29.7 49.2) rotate(-96.5) scale(1.6)',
] as const;

function PopularityStrip({ value, className }: ArtProps) {
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artDark, className)}>
      <g transform="translate(75 44) rotate(-16)">
        <polygon points="-6.8,19 6.8,19 6.3,26 -6.3,26" fill="#6E685F" />
        <polygon points="-6,27 6,27 4.2,60 -4.2,60" fill="#6E685F" />
        <polygon points="-4,19 -2.4,19 -1.6,60 -2.6,60" fill="#8F897E" />
        <rect x="-7" y="15.5" width="14" height="3.5" fill="#A8283D" />
        <polygon points="-9.6,9.5 9.6,9.5 7.2,15.5 -7.2,15.5" fill="#6E685F" />
        <polygon points="-5.5,9.5 -3.5,9.5 -3,15.5 -4.5,15.5" fill="#8F897E" />
        <circle cx="0" cy="0" r="13" fill="#D9D3C4" />
        <g fill="none" stroke="#6A645A" strokeWidth="0.8">
          <ellipse cx="0" cy="0" rx="5" ry="13" />
          <ellipse cx="0" cy="0" rx="10" ry="13" />
          <path d="M-9.4 -9 Q0 -11 9.4 -9" />
          <path d="M-12.2 -4.5 Q0 -6 12.2 -4.5" />
          <path d="M-12.2 4.5 Q0 6 12.2 4.5" />
          <path d="M-9.4 9 Q0 11 9.4 9" />
        </g>
        <rect x="-14.2" y="-1.9" width="28.4" height="3.8" rx="1.9" fill="#F7F3EA" />
      </g>
      {STRIP_BOLTS.map((bolt, i) => (
        <g
          key={bolt.transform}
          className={styles.popBolt}
          data-i={i}
          transform={bolt.transform}
          style={{ opacity: itemOpacity(value, i) }}
        >
          <path
            className={styles.zap}
            style={bolt.delay ? { animationDelay: bolt.delay } : undefined}
            d={BOLT_PATH}
            fill="#FFD84D"
          />
        </g>
      ))}
    </svg>
  );
}

function PopularityTab({ value, className }: ArtProps) {
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artDark, className)}>
      <g transform="translate(75 44) rotate(-16)">
        <polygon points="-6.8,19 6.8,19 4.2,60 -4.2,60" fill="#8F897E" />
        <rect x="-7" y="15.5" width="14" height="3.5" fill="#A8283D" />
        <polygon points="-9.6,9.5 9.6,9.5 7.2,15.5 -7.2,15.5" fill="#8F897E" />
        <circle cx="0" cy="0" r="13" fill="#D9D3C4" />
        <ellipse cx="0" cy="0" rx="6" ry="13" fill="none" stroke="#6A645A" strokeWidth="1.6" />
        <rect x="-14.2" y="-2.4" width="28.4" height="4.8" rx="2.4" fill="#F7F3EA" />
      </g>
      <g fill="#FFD84D">
        {TAB_BOLTS.map((transform, i) => (
          <path
            key={transform}
            className={styles.popBolt}
            data-i={i}
            transform={transform}
            d={BOLT_PATH}
            style={{ opacity: itemOpacity(value, i) }}
          />
        ))}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Tempo: a metronome. The pendulum swings at the speed and width metronome(value) gives, and its weight slides down.

const TICK_Y = ['18', '23', '28', '33', '38', '43', '48'] as const;

function TempoStrip({ value, className }: ArtProps) {
  const pendulum = metronome(value);
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artCream, className)}>
      <polygon points="75,2 86,8 64,8" fill="#8E5F35" />
      <polygon points="65,8 85,8 107,78 43,78" fill="#8E5F35" />
      <polygon points="68,11 82,11 94.5,54 55.5,54" fill="#191714" />
      <rect x="71" y="14" width="8" height="40" fill="#4A453D" />
      <line x1="75" y1="14" x2="75" y2="54" stroke="#D9D3C4" strokeWidth="1" />
      <g stroke="#D9D3C4" strokeWidth="0.8">
        {TICK_Y.map((y) => (
          <line key={y} x1="72.5" y1={y} x2="77.5" y2={y} />
        ))}
      </g>
      <g className={styles.metroPend} style={{ animation: pendulum.animation }}>
        <line x1="75" y1="62" x2="75" y2="14" stroke="#4A453D" strokeWidth="3" />
        <line x1="75" y1="62" x2="75" y2="14" stroke="#F7F3EA" strokeWidth="1.6" />
        <polygon
          points="66,0 84,0 80,10 70,10"
          fill="#F4E7C5"
          stroke="#4A453D"
          strokeWidth="0.8"
          transform={`translate(0 ${pendulum.weightY})`}
        />
      </g>
      <polygon points="50.6,54 99.4,54 107,78 43,78" fill="#A5703F" />
      <line x1="102.6" y1="64" x2="109" y2="64" stroke="#6A645A" strokeWidth="1.6" />
      <circle cx="112" cy="64" r="3.5" fill="none" stroke="#6A645A" strokeWidth="1.6" />
    </svg>
  );
}

function TempoTab({ value, className }: ArtProps) {
  const pendulum = metronome(value);
  return (
    <svg viewBox="0 0 150 80" aria-hidden="true" className={rootClass(styles.artCream, className)}>
      <polygon points="75,2 86,8 64,8" fill="#8E5F35" />
      <polygon points="65,8 85,8 107,78 43,78" fill="#8E5F35" />
      <polygon points="68,11 82,11 94.5,54 55.5,54" fill="#191714" />
      <g className={styles.metroPend} style={{ animation: pendulum.animation }}>
        <line x1="75" y1="62" x2="75" y2="14" stroke="#4A453D" strokeWidth="4.5" />
        <line x1="75" y1="62" x2="75" y2="14" stroke="#F7F3EA" strokeWidth="2.6" />
        <polygon
          points="66,0 84,0 80,10 70,10"
          fill="#F4E7C5"
          stroke="#4A453D"
          strokeWidth="1.2"
          transform={`translate(0 ${pendulum.weightY})`}
        />
      </g>
      <polygon points="50.6,54 99.4,54 107,78 43,78" fill="#A5703F" />
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
 * A gear's illustration at `value` (0 to 100). One root svg on a 150x80 viewBox, decorative (`aria-hidden`).
 * A gear that is off is drawn at its default value, dimmed by the parent's className.
 */
export function GearArt({ gear, variant, value, className }: GearArtProps) {
  const Art = ART[gear][variant];
  return <Art value={value} className={className} />;
}

// ---------------------------------------------------------------------------------------------------------------------
// Era

/** Where each era's dot sits along the bottom of the Era tab's art. */
const ERA_DOT_X: Record<EraId, string> = { pre: '19', s70: '23', s80: '27', s90: '31', s00: '35', s10: '39', s20: '43' };
const DOT_PICKED = '#FFD84D';
const DOT_NOT_PICKED = '#4A1B0C';

/** The Era tab's art: one dot per era, yellow for each era in `eras` and dark for the rest. */
export function EraTabArt({ eras, className }: { eras: readonly EraId[]; className?: string }) {
  return (
    <svg viewBox="0 0 62 33" aria-hidden="true" className={rootClass(styles.artBlack, className)}>
      <path d="M14 31 V15 A17 13 0 0 1 48 15 V31 Z" fill="#A8283D" />
      <path d="M19 21 V15 A12 9 0 0 1 43 15 V21 Z" fill="#F4E7C5" />
      <g stroke="#A8283D" strokeWidth="1">
        <line x1="25" y1="9" x2="25" y2="21" />
        <line x1="31" y1="6" x2="31" y2="21" />
        <line x1="37" y1="9" x2="37" y2="21" />
      </g>
      {ERA_IDS.map((era) => (
        <circle
          key={era}
          data-era={era}
          cx={ERA_DOT_X[era]}
          cy="26"
          r="1.6"
          fill={eras.includes(era) ? DOT_PICKED : DOT_NOT_PICKED}
        />
      ))}
    </svg>
  );
}

/** What every era icon shares: 26x26 on screen, drawn on a 30x30 grid in the button's text colour. */
const ICON = {
  width: '26',
  height: '26',
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

/** The icon inside an era button, one per era. Drawn in the button's text colour. */
export function EraIcon({ era }: { era: EraId }) {
  return ERA_ICONS[era];
}
