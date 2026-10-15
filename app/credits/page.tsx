import { CREDITS } from '../../src/lib/credits';
import styles from './credits.module.css';

export const metadata = { title: 'Sources and credits · karaoke-dokie' };

export default function Credits() {
  return (
    <main className={styles.page}>
      <a href="/" className={styles.back}>‹ Back</a>
      <h1 className={styles.title}>Sources and credits</h1>
      <ul className={styles.list}>
        {CREDITS.map((c) => (
          <li key={c.name}>
            <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a>
            <p>{c.what}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
