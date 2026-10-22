// Icons from Google Material Symbols (rounded, weight 400), https://fonts.google.com/icons,
// Apache License 2.0. Path data copied unchanged from the official SVG files.

import type { OctaveShift } from '../lib/contracts';

const PATHS = {
  directionsRun:
    'M535-70v-209l-108-99-36 159q-3 12-13 18.5t-22 4.5l-208-43q-11-2-18-12t-5-22q2-12 12.5-18t21.5-4l171 34 73-369-100 47v104q0 13-8.5 21.5T273-449q-13 0-21.5-8.5T243-479v-125q0-9 5-16.5t13-11.5l146-61q32-14 45.5-17.5T480-714q20 0 35.5 8.5T542-680l42 67q23 37 60 65.5t86 36.5q13 2 21.5 10.5T760-479q0 12-8.5 21t-20.5 7q-57-6-102.5-36.5T543-573l-39 158 81 75q5 5 7.5 10.5T595-318v248q0 13-8.5 21.5T565-40q-13 0-21.5-8.5T535-70Zm-46.5-705.5Q467-797 467-827t21.5-51.5Q510-900 540-900t51.5 21.5Q613-857 613-827t-21.5 51.5Q570-754 540-754t-51.5-21.5Z',
} as const;

interface IconProps {
  className?: string;
  size?: number;
}

function SvgIcon({ d, label, className, size = 18 }: IconProps & { d: string; label: string }) {
  return (
    <svg viewBox="0 -960 960 960" width={size} height={size} fill="currentColor" role="img" aria-label={label} className={className}>
      <title>{label}</title>
      <path d={d} />
    </svg>
  );
}

export const FAST_LYRICS_LABEL = 'Fast lyrics';
export const OCTAVE_UP_LABEL = 'Sing it an octave higher than the artist';
export const OCTAVE_DOWN_LABEL = 'Sing it an octave lower than the artist';

export function FastLyricsIcon(props: IconProps) {
  return <SvgIcon d={PATHS.directionsRun} label={FAST_LYRICS_LABEL} {...props} />;
}

/**
 * Octave shifts use the sheet-music marks "8va" (an octave higher) and "8vb" (an octave lower),
 * set in italic serif as in printed music, rather than an arrow icon that reads as upload/download.
 */
export function OctaveIcon({ octave, className, size = 18 }: IconProps & { octave: OctaveShift }) {
  if (octave === 'none') return null;
  const label = octave === 'up' ? OCTAVE_UP_LABEL : OCTAVE_DOWN_LABEL;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={className}
      style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic', fontWeight: 700, fontSize: size * 0.8, lineHeight: 1, letterSpacing: '0.01em', width: 'auto' }}
    >
      {octave === 'up' ? '8va' : '8vb'}
    </span>
  );
}
