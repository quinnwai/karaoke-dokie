import styles from './screen.module.css';

/**
 * Where the browser's own microphone question shows up on this phone (QWW-50), drawn so a singer knows what to
 * look for and which button to tap: a box in the middle of the screen on iPhone, a sheet from the bottom on
 * Android. Plain shapes, one word ("Allow"), so it needs no translation.
 */
export function MicArt({ where }: { where: 'center' | 'sheet' }) {
  const label =
    where === 'center'
      ? 'A phone with a box in the middle of its screen. The Allow button, on the right, is lit up.'
      : 'A phone with a panel sliding up from the bottom of its screen. The top button, Allow, is lit up.';
  return (
    <svg className={styles.micArt} viewBox="0 0 120 156" role="img" aria-label={label}>
      <rect x="3" y="3" width="114" height="150" rx="17" fill="#0b0a0f" stroke="rgba(244,241,246,0.5)" strokeWidth="3" />
      {where === 'center' ? (
        <>
          <rect x="17" y="44" width="86" height="68" rx="10" fill="#2b2931" />
          <rect x="29" y="55" width="62" height="5" rx="2.5" fill="rgba(244,241,246,0.4)" />
          <rect x="35" y="65" width="50" height="5" rx="2.5" fill="rgba(244,241,246,0.25)" />
          <rect x="17" y="84" width="86" height="1.5" fill="rgba(244,241,246,0.16)" />
          <rect x="60" y="84" width="1.5" height="28" fill="rgba(244,241,246,0.16)" />
          <rect className={styles.micPulse} x="63" y="88" width="37" height="21" rx="7" fill="none" stroke="var(--pink)" strokeWidth="2" />
          <rect x="64" y="89" width="35" height="19" rx="6" fill="var(--pink)" />
          <text x="81.5" y="102" textAnchor="middle" fontSize="11" fontWeight="800" fill="#07060a">
            Allow
          </text>
        </>
      ) : (
        <>
          <rect x="9" y="76" width="102" height="68" rx="10" fill="#2b2931" />
          <rect x="22" y="85" width="62" height="5" rx="2.5" fill="rgba(244,241,246,0.4)" />
          <rect className={styles.micPulse} x="17" y="95" width="86" height="19" rx="9.5" fill="none" stroke="var(--pink)" strokeWidth="2" />
          <rect x="18" y="96" width="84" height="17" rx="8.5" fill="var(--pink)" />
          <text x="60" y="108" textAnchor="middle" fontSize="11" fontWeight="800" fill="#07060a">
            Allow
          </text>
          <rect x="18" y="118" width="84" height="10" rx="5" fill="rgba(244,241,246,0.16)" />
          <rect x="18" y="131" width="84" height="10" rx="5" fill="rgba(244,241,246,0.1)" />
        </>
      )}
    </svg>
  );
}
