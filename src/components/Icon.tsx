// Icons from Google Material Symbols (rounded, weight 400), https://fonts.google.com/icons,
// Apache License 2.0. Path data copied unchanged from the official SVG files.

import type { OctaveShift } from '../lib/contracts';

const PATHS = {
  directionsRun:
    'M535-70v-209l-108-99-36 159q-3 12-13 18.5t-22 4.5l-208-43q-11-2-18-12t-5-22q2-12 12.5-18t21.5-4l171 34 73-369-100 47v104q0 13-8.5 21.5T273-449q-13 0-21.5-8.5T243-479v-125q0-9 5-16.5t13-11.5l146-61q32-14 45.5-17.5T480-714q20 0 35.5 8.5T542-680l42 67q23 37 60 65.5t86 36.5q13 2 21.5 10.5T760-479q0 12-8.5 21t-20.5 7q-57-6-102.5-36.5T543-573l-39 158 81 75q5 5 7.5 10.5T595-318v248q0 13-8.5 21.5T565-40q-13 0-21.5-8.5T535-70Zm-46.5-705.5Q467-797 467-827t21.5-51.5Q510-900 540-900t51.5 21.5Q613-857 613-827t-21.5 51.5Q570-754 540-754t-51.5-21.5Z',
  menuBook:
    'M260-320q47 0 91.5 10.5T440-278v-394q-41-24-87-36t-93-12q-36 0-71.5 7T120-692v396q35-12 69.5-18t70.5-6Zm260 42q44-21 88.5-31.5T700-320q36 0 70.5 6t69.5 18v-396q-33-14-68.5-21t-71.5-7q-47 0-93 12t-87 36v394Zm-66.5 93.5Q441-188 430-194q-39-23-82-34.5T260-240q-42 0-82.5 11T100-198q-21 11-40.5-1T40-234v-482q0-11 5.5-21T62-752q46-24 96-36t102-12q58 0 113.5 15T480-740q51-30 106.5-45T700-800q52 0 102 12t96 36q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-45 0-88 11.5T530-194q-11 6-23.5 9.5T480-181q-14 0-26.5-3.5ZM280-494Zm280-115q0-9 6.5-18.5T581-640q29-10 58-15t61-5q20 0 39.5 2.5T778-651q9 2 15.5 10t6.5 18q0 17-11 25t-28 4q-14-3-29.5-4.5T700-600q-26 0-51 5t-48 13q-18 7-29.5-1T560-609Zm0 220q0-9 6.5-18.5T581-420q29-10 58-15t61-5q20 0 39.5 2.5T778-431q9 2 15.5 10t6.5 18q0 17-11 25t-28 4q-14-3-29.5-4.5T700-380q-26 0-51 4.5T601-363q-18 7-29.5-.5T560-389Zm0-110q0-9 6.5-18.5T581-530q29-10 58-15t61-5q20 0 39.5 2.5T778-541q9 2 15.5 10t6.5 18q0 17-11 25t-28 4q-14-3-29.5-4.5T700-490q-26 0-51 5t-48 13q-18 7-29.5-1T560-499Z',
  restartAlt:
    'M393-132q-103-29-168-113.5T160-440q0-57 19-108.5t54-94.5q11-12 27-12.5t29 12.5q11 11 11.5 27T290-586q-24 31-37 68t-13 78q0 81 47.5 144.5T410-209q13 4 21.5 15t8.5 24q0 20-14 31.5t-33 6.5Zm174 0q-19 5-33-7t-14-32q0-12 8.5-23t21.5-15q75-24 122.5-87T720-440q0-100-70-170t-170-70h-3l16 16q11 11 11 28t-11 28q-11 11-28 11t-28-11l-84-84q-6-6-8.5-13t-2.5-15q0-8 2.5-15t8.5-13l84-84q11-11 28-11t28 11q11 11 11 28t-11 28l-16 16h3q134 0 227 93t93 227q0 109-65 194T567-132Z',
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

/** The open book on the Sources and credits link. Decorative: the link carries the name. */
export function BookIcon({ className, size = 18 }: IconProps) {
  return (
    <svg viewBox="0 -960 960 960" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d={PATHS.menuBook} />
    </svg>
  );
}

/** The circular arrow on a panel's Reset button. Decorative: the button carries the name. */
export function ResetIcon({ className, size = 18 }: IconProps) {
  return (
    <svg viewBox="0 -960 960 960" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d={PATHS.restartAlt} />
    </svg>
  );
}

// The Spotify logo, path from Simple Icons (CC0), https://simpleicons.org/?q=spotify.
const SPOTIFY_PATH =
  'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z';

/** Decorative: the button around it carries the name. */
export function SpotifyIcon({ className, size = 22 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d={SPOTIFY_PATH} />
    </svg>
  );
}

// Deezer's current logo mark, path from Simple Icons (CC0), https://simpleicons.org/?q=deezer, which takes it from
// Deezer's brand site (https://deezerbrand.com/document/37#/-/logo). Deezer's purple is #A238FF.
const DEEZER_PATH =
  'M.693 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807C.312 4.41 0 5.666 0 7.217s.312 2.808.693 2.808ZM21.038 1.56c-.364 0-.684.805-.91 2.096C19.765 1.446 19.184 0 18.526 0c-.78 0-1.464 2.036-1.784 5-.312-2.158-.788-3.536-1.325-3.536-.745 0-1.386 2.704-1.62 6.472-.442-1.932-1.083-3.145-1.793-3.145s-1.35 1.213-1.793 3.145c-.242-3.76-.874-6.463-1.628-6.463-.537 0-1.013 1.378-1.325 3.535C6.938 2.036 6.262 0 5.474 0c-.658 0-1.247 1.447-1.602 3.665-.217-1.291-.546-2.105-.91-2.105-.675 0-1.221 2.807-1.221 6.272 0 3.466.546 6.273 1.221 6.273.277 0 .537-.476.736-1.273.32 2.928.996 4.938 1.776 4.938.606 0 1.143-1.204 1.507-3.11.251 3.622.875 6.195 1.602 6.195.46 0 .875-1.023 1.187-2.677C10.142 21.6 11 24 12.004 24c1.005 0 1.863-2.4 2.235-5.822.312 1.654.727 2.677 1.186 2.677.728 0 1.352-2.573 1.603-6.195.364 1.906.9 3.11 1.507 3.11.78 0 1.455-2.01 1.775-4.938.208.797.46 1.273.737 1.273.675 0 1.22-2.807 1.22-6.273-.008-3.457-.553-6.272-1.23-6.272ZM23.307 10.024c.381 0 .693-1.256.693-2.807 0-1.55-.312-2.807-.693-2.807-.381 0-.693 1.256-.693 2.807s.312 2.808.693 2.808Z';

/** Decorative: the word "Deezer" beside it carries the name. */
export function DeezerIcon({ className, size = 16 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false" className={className}>
      <path d={DEEZER_PATH} />
    </svg>
  );
}
