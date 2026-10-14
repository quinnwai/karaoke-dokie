import styles from './screen.module.css';

interface LyricProps {
  text: string;
  /** Smaller line under the main one. */
  small?: boolean;
  /** Seconds before the first word lights up. */
  delay?: number;
}

/**
 * One line of on-screen instruction, sung in like a karaoke lyric: each word
 * flashes pink in turn, then settles. Remounts (and replays) when the text changes.
 */
export function Lyric({ text, small, delay = 0 }: LyricProps) {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <p key={text} className={small ? styles.lyricSmall : styles.lyric} aria-live="polite" data-lyric>
      {words.map((word, i) => (
        <span key={i} className={styles.word} style={{ animationDelay: `${delay + i * 0.24}s` }}>
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  );
}
