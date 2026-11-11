import type { ButtonHTMLAttributes } from 'react';
import styles from './screen.module.css';

interface RoundButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Lit: held down on the note steps, waiting for the browser's answer on the mic step. */
  active?: boolean;
}

/**
 * The round, pink-ringed button the singer taps or holds: the record button on the two note steps (a dot in the
 * middle) and "Turn on microphone" on the mic step (a microphone). One component, so the two keep the same size and look.
 * What goes inside, and what a press does, is up to the caller.
 */
export function RoundButton({ active = false, className, ...props }: RoundButtonProps) {
  const classes = [styles.roundButton, active && styles.roundActive, className].filter(Boolean).join(' ');
  return <button type="button" className={classes} {...props} />;
}
