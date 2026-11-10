import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HEARD_LEVEL } from '../lib/audio/level';
import { chromeIntentUrl, type BrowserInfo, type InApp } from '../lib/client/browser';
import type { MicGate } from '../lib/client/flow';
import type { MicProblem } from '../lib/client/mic';
import { Lyric } from './Lyric';
import { MicArt } from './MicArt';
import styles from './screen.module.css';

// The microphone step (QWW-50). The browser's own question is a step we do not control, and older singers often
// miss it, close it or tap Block, so every screen here is plain words, big type and big buttons, and no screen is
// a dead end: each has a way on, and the way out of a refusal says how, for this browser. The one thing to tap on
// each screen stays at the bottom of the screen while the words scroll under it, so a small phone, or one set to
// larger text, never hides it.

/** How long the level meter listens to a running microphone before it says it hears nothing. */
export const QUIET_HINT_MS = 5000;
/** How long the browser's question can stay unanswered before the screen offers a reload. */
export const ASKING_PATIENCE_MS = 12000;
/** How long the blank screen (looking at the browser, or opening a microphone already allowed) may last before it offers a reload. */
export const BUSY_PATIENCE_MS = 4000;
const POLL_MS = 50;
/** A voice must stay past the line this many polls in a row (150 ms), so a tap on the screen or a rub of the case is not one. */
const HEARD_FRAMES = 3;
const QUIET_FRAMES = QUIET_HINT_MS / POLL_MS;

interface MicStepProps {
  gate: MicGate;
  /** How loud the microphone is hearing right now, 0 to 1; null while the audio has not started (it waits for a tap). */
  readLevel(): number | null;
  /** "Turn on microphone" and "Try again": the tap that brings up the browser's own question. */
  onAsk(): void;
  onTryHere(): void;
  onContinue(): void;
  /** Any tap on the level screen: starts the audio if the browser held it back. */
  onWake(): void;
  onReload(): void;
}

/** True once `ms` have passed with `active` on, and false again when it goes off. */
function useAfter(active: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setLate(true), ms);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [active, ms]);
  return late;
}

export function MicStep({ gate, readLevel, onAsk, onTryHere, onContinue, onWake, onReload }: MicStepProps) {
  const { view, env } = gate;
  // Looking at the browser, or opening a microphone that was already allowed: nothing to read yet.
  if (!env || view === 'checking' || view === 'opening') return <BusyScreen view={view} onReload={onReload} />;
  switch (view) {
    case 'inapp':
      return <InAppScreen env={env} onNext={onTryHere} />;
    case 'prompt':
    case 'asking':
      return <PromptScreen env={env} asking={view === 'asking'} onAsk={onAsk} onReload={onReload} />;
    case 'level':
      return <LevelScreen readLevel={readLevel} onContinue={onContinue} onWake={onWake} />;
    case 'recovery':
      return <RecoveryScreen gate={gate} env={env} onAsk={onAsk} onReload={onReload} />;
  }
}

const deviceOf = (env: BrowserInfo) => (env.os === 'other' ? 'browser' : 'phone');

/** The one thing to tap, kept on screen while the rest scrolls under it. */
function Main({ children }: { children: ReactNode }) {
  return <div className={styles.micMain}>{children}</div>;
}

/** Blank on purpose, since it lasts a moment. If it does not, the singer is not left looking at nothing. */
function BusyScreen({ view, onReload }: { view: MicGate['view']; onReload(): void }) {
  const late = useAfter(true, BUSY_PATIENCE_MS);
  return (
    <div className={styles.center} aria-busy={!late} data-mic-view={view}>
      {late && (
        <button type="button" className={styles.micLink} onClick={onReload}>
          Nothing happened? Reload this page
        </button>
      )}
    </div>
  );
}

// ---- before the browser's question ----

function PromptScreen({ env, asking, onAsk, onReload }: { env: BrowserInfo; asking: boolean; onAsk(): void; onReload(): void }) {
  const device = deviceOf(env);
  // A question that never comes (some in-app browsers say nothing at all) must not leave the singer waiting for ever.
  const late = useAfter(asking, ASKING_PATIENCE_MS);

  return (
    <div className={styles.mic} data-mic-view={asking ? 'asking' : 'prompt'}>
      <Lyric text="We need to hear you sing" />
      <MicArt where={env.os === 'android' ? 'sheet' : 'center'} />
      <p className={styles.micBody}>
        Your {device} will ask to use the microphone. Tap <strong>Allow</strong>.
      </p>
      <Main>
        <button type="button" className={styles.micButton} onClick={onAsk} disabled={asking}>
          {asking ? `Waiting for your ${device}…` : 'Turn on microphone'}
        </button>
      </Main>
      {late ? (
        <button type="button" className={styles.micLink} onClick={onReload}>
          Nothing happened? Reload this page
        </button>
      ) : (
        <p className={styles.micNote}>Your voice stays on your {device}.</p>
      )}
    </div>
  );
}

// ---- inside another app's browser ----

const APP_NAMES: Record<InApp, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  messenger: 'Messenger',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  snapchat: 'Snapchat',
  line: 'LINE',
  wechat: 'WeChat',
  webview: 'another app',
};

/** Copies the link. Some in-app browsers refuse the clipboard, so then the link is selected for a long press. */
async function copyLink(href: string, field: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(href);
    return true;
  } catch {
    if (!field) return false;
    field.focus();
    field.select();
    field.setSelectionRange(0, href.length); // iOS ignores select() on its own
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

/**
 * Before the microphone, when the page is inside another app's browser; and again after a refusal there, since that
 * browser has no site settings to open and the way out is another browser. `recovery` swaps the last link, "Try here
 * anyway", for "Try again".
 */
function InAppScreen({ env, recovery = false, onNext }: { env: BrowserInfo; recovery?: boolean; onNext(): void }) {
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const href = window.location.href;
  const target = env.os === 'ios' ? 'Safari' : env.os === 'android' ? 'Chrome' : 'your browser';
  const app = APP_NAMES[env.inApp ?? 'webview'];
  const copy = (
    <button
      type="button"
      className={`${styles.micButton} ${env.os === 'android' ? styles.micButtonQuiet : ''}`}
      onClick={() => void copyLink(href, field.current).then(setCopied)}
    >
      {copied ? 'Link copied ✓' : 'Copy link'}
    </button>
  );

  return (
    <div className={styles.mic} data-mic-view={recovery ? 'recovery' : 'inapp'} data-app={env.inApp ?? 'webview'}>
      <Lyric text={`Open this in ${target}`} />
      <p className={styles.micBody}>This page is open inside {app}. That kind of built-in browser often can’t use the microphone.</p>
      {env.os === 'android' ? (
        <>
          <Main>
            <a className={styles.micButton} href={chromeIntentUrl(href)}>
              Open in Chrome
            </a>
          </Main>
          <p className={styles.micNote}>
            Or tap the <strong>⋮</strong> menu, then <strong>Open in Chrome</strong> or <strong>Open in browser</strong>.
          </p>
          {copy}
        </>
      ) : (
        <>
          <ol className={styles.micSteps} role="list">
            <li>
              <span>
                Tap the <strong>•••</strong> or <strong>compass</strong> icon
              </span>
            </li>
            <li>
              <span>
                Tap <strong>Open in {env.os === 'ios' ? 'Safari' : 'your browser'}</strong> or <strong>Open in browser</strong>
              </span>
            </li>
          </ol>
          <p className={styles.micNote}>Or copy the link and paste it into {target}.</p>
          <Main>{copy}</Main>
        </>
      )}
      <input ref={field} className={styles.micField} readOnly value={href} aria-label="Link to this page" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className={styles.micLink} onClick={onNext}>
        {recovery ? 'Try again' : 'Try here anyway'}
      </button>
    </div>
  );
}

// ---- the microphone is on ----

function LevelScreen({ readLevel, onContinue, onWake }: { readLevel(): number | null; onContinue(): void; onWake(): void }) {
  const fill = useRef<HTMLDivElement>(null);
  const [heard, setHeard] = useState(false);
  const [silent, setSilent] = useState(false);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    let shown = 0;
    let streak = 0;
    let quietFrames = 0;
    let loud = false;
    let wasStalled = false;
    const poll = setInterval(() => {
      const level = readLevel();
      // The microphone is on but the browser has not let the audio start (no tap yet): that is not a quiet room.
      if ((level === null) !== wasStalled) {
        wasStalled = level === null;
        setStalled(wasStalled);
      }
      if (level === null) return;
      // Up at once, down gently, so a word reads as one swing of the bar.
      shown = Math.max(level, shown * 0.8);
      if (fill.current) fill.current.style.transform = `scaleX(${shown.toFixed(3)})`;
      streak = level >= HEARD_LEVEL ? streak + 1 : 0;
      if (!loud && streak >= HEARD_FRAMES) {
        loud = true;
        setHeard(true);
      }
      if (!loud && ++quietFrames === QUIET_FRAMES) setSilent(true);
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [readLevel]);

  return (
    <div className={styles.mic} data-mic-view="level" onPointerDown={onWake}>
      <Lyric text="Say “ahh”" />
      <p className={styles.micBody}>The bar should move when you talk.</p>
      <div className={styles.meter} aria-hidden data-heard={heard}>
        <div ref={fill} className={styles.meterFill} />
      </div>
      <p className={styles.micStatus} role="status">
        {heard ? 'We can hear you ✓' : stalled ? 'Tap anywhere to start listening' : silent ? 'We can’t hear anything yet' : 'Listening…'}
      </p>
      {silent && !heard && !stalled && (
        <p className={styles.micNote}>Make sure nothing covers the microphone, and that Bluetooth headphones are off.</p>
      )}
      <Main>
        <button type="button" className={styles.micButton} onClick={onContinue}>
          Continue
        </button>
      </Main>
    </div>
  );
}

// ---- it did not work ----

/** Safari on an iPhone and Chrome on Android are the browsers we point to; in either, "open it in another browser" is no help. */
const isBestBrowser = (env: BrowserInfo) => (env.os === 'ios' && env.browser === 'safari') || (env.os === 'android' && env.browser === 'chrome');

function titleFor(problem: MicProblem, env: BrowserInfo): string {
  switch (problem) {
    case 'denied':
      return 'The microphone is blocked';
    case 'dismissed':
      return 'The question was closed';
    case 'system':
      return 'Your phone is blocking the microphone';
    case 'missing':
      return 'We can’t find a microphone';
    case 'busy':
      return 'The microphone is busy';
    case 'unsupported':
      return isBestBrowser(env) ? 'The microphone didn’t start' : 'This browser can’t use the microphone';
  }
}

function bodyFor(problem: MicProblem, env: BrowserInfo): ReactNode {
  const device = deviceOf(env);
  switch (problem) {
    case 'denied':
      return <>Your {device} said no. Here’s how to switch it on:</>;
    case 'dismissed':
      return (
        <>
          Tap <strong>Try again</strong>, then tap <strong>Allow</strong>. If the question doesn’t come back:
        </>
      );
    case 'system':
      return <>Your {device}’s own settings are blocking your browser. Here’s how to switch it on:</>;
    case 'missing':
      return (
        <>
          This {device} doesn’t seem to have a microphone we can use. If a headset is plugged in, unplug it, then tap <strong>Try again</strong>.
        </>
      );
    case 'busy':
      return (
        <>
          Another app may be using the microphone. Close apps that record or make calls, then tap <strong>Try again</strong>.
        </>
      );
    case 'unsupported':
      if (isBestBrowser(env)) {
        return (
          <>
            Something went wrong. Tap <strong>Try again</strong>, or reload this page.
          </>
        );
      }
      return <>Open this page in {env.os === 'ios' ? 'Safari' : env.os === 'android' ? 'Chrome' : 'Chrome or Safari'} and try again.</>;
  }
}

/** The problems that have steps to follow in a settings screen. */
const HAS_STEPS: MicProblem[] = ['denied', 'dismissed', 'system'];

/** Where this browser, or this phone, keeps its microphone switch, one tap at a time. */
function stepsFor(env: BrowserInfo, problem: MicProblem): ReactNode[] {
  const again = (
    <>
      Then tap <strong>Try again</strong>
    </>
  );
  if (problem === 'system' && env.os === 'android') {
    return [
      <>
        Open your phone’s <strong>Settings</strong>
      </>,
      <>
        Tap <strong>Apps</strong>, then your browser (such as <strong>Chrome</strong>), then <strong>Permissions</strong>
      </>,
      <>
        Turn on <strong>Microphone</strong>
      </>,
      again,
    ];
  }
  if (env.os === 'ios' && env.browser === 'safari' && problem !== 'system') {
    return [
      <>
        Tap <strong>aA</strong> in the address bar
      </>,
      <>
        Tap <strong>Website Settings</strong>
      </>,
      <>
        Set <strong>Microphone</strong> to <strong>Allow</strong>
      </>,
      again,
    ];
  }
  if (env.os === 'ios') {
    return [
      <>
        Open your iPhone’s <strong>Settings</strong> app
      </>,
      <>
        Find your browser in the list and turn on <strong>Microphone</strong>
      </>,
      again,
    ];
  }
  if (env.os === 'android') {
    return [
      <>
        Tap the <strong>lock</strong> or <strong>settings</strong> icon by the web address
      </>,
      <>
        Tap <strong>Permissions</strong>
      </>,
      <>
        Turn on <strong>Microphone</strong>
      </>,
      again,
    ];
  }
  return [
    <>
      Click the <strong>lock</strong> icon by the web address
    </>,
    <>
      Set <strong>Microphone</strong> to <strong>Allow</strong>
    </>,
    again,
  ];
}

function RecoveryScreen({ gate, env, onAsk, onReload }: { gate: MicGate; env: BrowserInfo; onAsk(): void; onReload(): void }) {
  // Inside another app's browser there are no site settings to open: the way out is another browser.
  if (env.inApp) return <InAppScreen env={env} recovery onNext={onAsk} />;
  const problem = gate.problem ?? 'denied';
  const steps = HAS_STEPS.includes(problem);
  return (
    <div className={styles.mic} data-mic-view="recovery" data-problem={problem}>
      <Lyric text={titleFor(problem, env)} />
      <p className={styles.micBody}>{bodyFor(problem, env)}</p>
      {steps && env.os === 'ios' && (
        <p className={styles.micNote}>{env.browser === 'safari' ? 'Safari' : 'Your browser'} may ask again each time you open this page. That’s normal.</p>
      )}
      {steps && (
        <ol className={styles.micSteps} role="list">
          {stepsFor(env, problem).map((step, i) => (
            <li key={i}>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
      {gate.fails > 1 && (
        <p className={styles.micWarn} role="status">
          Still not working. Follow the steps, then tap Try again.
        </p>
      )}
      <Main>
        <button type="button" className={styles.micButton} onClick={onAsk}>
          Try again
        </button>
      </Main>
      {/* Reloading is the quick fix on an iPhone, where Safari asks again after a reload, so it sits right under the main button. */}
      <button type="button" className={styles.micLink} onClick={onReload}>
        Reload this page
      </button>
    </div>
  );
}
