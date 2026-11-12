import { ANALYTICS_NOTE, CREDITS } from '../lib/credits';
import { DeezerIcon } from './Icon';
import styles from './CreditsContent.module.css';

/**
 * What Sources and credits says: each source with what we use it for, and the note on what the beta records. The panel inside the TV
 * (CreditsPanel) and the /credits page both draw it, so they cannot differ. No hooks and no 'use client', so the server page can draw it too.
 */
export function CreditsContent() {
  return (
    <>
      <ul className={styles.list}>
        {CREDITS.map((c) => (
          <li key={c.name}>
            <a href={c.url} target="_blank" rel="noreferrer">
              {c.mark === 'deezer' && <DeezerIcon className={styles.deezer} />}
              {c.name}
            </a>
            <p>{c.what}</p>
          </li>
        ))}
      </ul>
      <section className={styles.note}>
        <h2>{ANALYTICS_NOTE.title}</h2>
        {ANALYTICS_NOTE.paragraphs.map((text) => (
          <p key={text}>{text}</p>
        ))}
      </section>
    </>
  );
}
