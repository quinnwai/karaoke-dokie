// Icons from Google Material Symbols (rounded, weight 400), https://fonts.google.com/icons,
// Apache License 2.0. Path data copied unchanged from the official SVG files.

import type { OctaveShift } from '../lib/contracts';

const PATHS = {
  directionsRun:
    'M535-70v-209l-108-99-36 159q-3 12-13 18.5t-22 4.5l-208-43q-11-2-18-12t-5-22q2-12 12.5-18t21.5-4l171 34 73-369-100 47v104q0 13-8.5 21.5T273-449q-13 0-21.5-8.5T243-479v-125q0-9 5-16.5t13-11.5l146-61q32-14 45.5-17.5T480-714q20 0 35.5 8.5T542-680l42 67q23 37 60 65.5t86 36.5q13 2 21.5 10.5T760-479q0 12-8.5 21t-20.5 7q-57-6-102.5-36.5T543-573l-39 158 81 75q5 5 7.5 10.5T595-318v248q0 13-8.5 21.5T565-40q-13 0-21.5-8.5T535-70Zm-46.5-705.5Q467-797 467-827t21.5-51.5Q510-900 540-900t51.5 21.5Q613-857 613-827t-21.5 51.5Q570-754 540-754t-51.5-21.5Z',
  upload:
    'M220-160q-24 0-42-18t-18-42v-113q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v113h520v-113q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v113q0 24-18 42t-42 18H220Zm230-524-99 99q-8.8 9-20.9 8.5-12.1-.5-21.49-9.5-8.61-9-8.61-21.5t9-21.5l150-150q5-5 10.13-7 5.14-2 11-2 5.87 0 10.87 2 5 2 10 7l151 151q9 9 9 21t-8.61 21q-9.39 9-21.89 9t-21.5-9l-99-98v341q0 12.75-8.68 21.37-8.67 8.63-21.5 8.63-12.82 0-21.32-8.63-8.5-8.62-8.5-21.37v-341Z',
  download:
    'M469-327q-5-2-10-7L308-485q-9-9.27-8.5-21.64.5-12.36 9.11-21.36 9.39-9 21.89-9t21.5 9l98 99v-341q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v341l99-99q8.8-9 20.9-8.5 12.1.5 21.49 9.5 8.61 9 8.61 21.5t-9 21.5L501-334q-5 5-10.13 7-5.14 2-11 2-5.87 0-10.87-2ZM220-160q-24 0-42-18t-18-42v-113q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v113h520v-113q0-12.75 8.68-21.38 8.67-8.62 21.5-8.62 12.82 0 21.32 8.62 8.5 8.63 8.5 21.38v113q0 24-18 42t-42 18H220Z',
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

export function OctaveIcon({ octave, ...props }: IconProps & { octave: OctaveShift }) {
  if (octave === 'up') return <SvgIcon d={PATHS.upload} label={OCTAVE_UP_LABEL} {...props} />;
  if (octave === 'down') return <SvgIcon d={PATHS.download} label={OCTAVE_DOWN_LABEL} {...props} />;
  return null;
}
