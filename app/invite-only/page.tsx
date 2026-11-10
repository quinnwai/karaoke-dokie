import styles from './invite-only.module.css';

export const metadata = { title: 'Spotify sign-in is invite-only · karaoke-dokie' };

/**
 * Where the sign-in callback sends an account Spotify refused with a 403 (QWW-53): in Development Mode only the
 * accounts added by hand in Spotify's dashboard can sign in (QWW-45). "Continue" goes back to `/`, which still has
 * the singer's range (kept on the device for the round trip), so nothing is sung again.
 */
export default function InviteOnly() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Spotify sign-in is invite-only during the beta</h1>
      <p>Spotify only lets us sign in the accounts we’ve added by hand, and yours isn’t on the list yet.</p>
      <p>
        To get added, send the person who invited you the email address on your Spotify account. In the Spotify app
        it’s under Settings, then Account. It can be different from the email you use most.
      </p>
      <p>Everything else works without Spotify.</p>
      <a href="/" className={styles.continue}>
        Continue without Spotify
      </a>
    </main>
  );
}
