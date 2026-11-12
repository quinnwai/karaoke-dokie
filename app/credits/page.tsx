import { CreditsBack } from '../../src/components/CreditsBack';
import { CreditsContent } from '../../src/components/CreditsContent';
import styles from './credits.module.css';

export const metadata = { title: 'Sources and credits · karaoke-dokie' };

// The app opens Sources and credits in a panel inside its TV (QWW-57, R28); this page is the same content for a direct visit and for old links.
export default function Credits() {
  return (
    <main className={styles.page}>
      <CreditsBack className={styles.back} />
      <h1 className={styles.title}>Sources and credits</h1>
      <CreditsContent />
    </main>
  );
}
