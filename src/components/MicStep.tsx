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
// a dead end: each has a way on, and the way out of a refusal says how, for this browser.

/** How long the level meter waits for a sound before it says it hears nothing. */
export const QUIET_HINT_MS = 5000;
/** How long the browser's question can stay unanswered before the screen offers a reload. */
export const ASKING_PATIENCE_MS = 12000;
const POLL_MS = 50;

interface MicStepProps {
  gate: MicGate;
  /** How loud the microphone is hearing right now, 0 to 1. */
  readLevel(): number;
  /** "Turn on microphone" and "Try again": the tap that brings up the browser's own question. */
  onAsk(): void;
  onTryHere(): void;
  onContinue(): void;
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

export function MicStep({ gate, readLevel, onAsk, onTryHere, onContinue, onReload }: MicStepProps) {
  const { view, env } = gate;
  // Looking at the browser, or opening a microphone that was already allowed: nothing to read yet.
  if (!env || view === 'checking' || view === 'opening') return <BusyScreen view={view} onReload={onReload} />;
  switch (view) {
    case 'inapp':
      return <InAppScreen env={env} onTryHere={onTryHere} />;
    case 'prompt':
    case 'asking':
      return <PromptScreen env={env} asking={view === 'asking'} onAsk={onAsk} onReload={onReload} />;
    case 'level':
      return <LevelScreen readLevel={readLevel} onContinue={onContinue} />;
    case 'recovery':
      return <RecoveryScreen gate={gate} env={env} onAsk={onAsk} onReload={onReload} />;
  }
}

const deviceOf = (env: BrowserInfo) => (env.os === 'other' ? 'browser' : 'phone');

/** Blank on purpose, since it lasts a moment. If it does not, the singer is not left looking at nothing. */
function BusyScreen({ view, onReload }: { view: MicGate['view']; onReload(): void }) {
  const late = useAfter(true, ASKING_PATIENCE_MS);
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
      <button type="button" className={styles.micButton} onClick={onAsk} disabled={asking}>
        {asking ? `Waiting for your ${device}…` : 'Turn on microphone'}
      </button>
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

function InAppScreen({ env, onTryHere }: { env: BrowserInfo; onTryHere(): void }) {
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
    <div className={styles.mic} data-mic-view="inapp" data-app={env.inApp ?? 'webview'}>
      <Lyric text={`Open this in ${target}`} />
      <p className={styles.micBody}>This page is open inside {app}. Windows like that often can’t use the microphone.</p>
      {env.os === 'android' ? (
        <>
          <a className={styles.micButton} href={chromeIntentUrl(href)}>
            Open in Chrome
          </a>
          <p className={styles.micNote}>
            Or tap the <strong>⋮</strong> menu, then <strong>Open in browser</strong>.
          </p>
          {copy}
        </>
      ) : (
        <>
          <ol className={styles.micSteps}>
            <li>
              <span>
                Tap the <strong>•••</strong> or <strong>compass</strong> icon
              </span>
            </li>
            <li>
              <span>
                Tap <strong>Open in {env.os === 'ios' ? 'Safari' : 'your browser'}</strong>
              </span>
            </li>
          </ol>
          <p className={styles.micNote}>Or copy the link and paste it into {target}.</p>
          {copy}
        </>
      )}
      <input ref={field} className={styles.micField} readOnly value={href} aria-label="Link to this page" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className={styles.micLink} onClick={onTryHere}>
        Try here anyway
      </button>
    </div>
  );
}

// ---- the microphone is on ----

function LevelScreen({ readLevel, onContinue }: { readLevel(): number; onContinue(): void }) {
  const fill = useRef<HTMLDivElement>(null);
  const [heard, setHeard] = useState(false);
  const [silent, setSilent] = useState(false);

  useEffect(() => {
    let shown = 0;
    let loud = false;
    const poll = setInterval(() => {
      const level = readLevel();
      // Up at once, down gently, so a word reads as one swing of the bar.
      shown = Math.max(level, shown * 0.8);
      if (fill.current) fill.current.style.transform = `scaleX(${shown.toFixed(3)})`;
      if (!loud && level >= HEARD_LEVEL) {
        loud = true;
        setHeard(true);
      }
    }, POLL_MS);
    const hint = setTimeout(() => {
      if (!loud) setSilent(true);
    }, QUIET_HINT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(hint);
    };
  }, [readLevel]);

  return (
    <div className={styles.mic} data-mic-view="level">
      <Lyric text="Say “ahh”" />
      <p className={styles.micBody}>The bar should move when you talk.</p>
      <div className={styles.meter} aria-hidden data-heard={heard}>
        <div ref={fill} className={styles.meterFill} />
      </div>
      <p className={styles.micStatus} role="status">
        {heard ? 'We can hear you ✓' : silent ? 'We can’t hear anything yet' : 'Listening…'}
      </p>
      {silent && !heard && (
        <p className={styles.micNote}>Make sure nothing covers the microphone, and that no headset is picked as the microphone.</p>
      )}
      <button type="button" className={styles.micButton} onClick={onContinue}>
        Continue
      </button>
    </div>
  );
}

// ---- it did not work ----

const TITLES: Record<MicProblem, string> = {
  denied: 'The microphone is blocked',
  dismissed: 'The question was closed',
  missing: 'We can’t find a microphone',
  busy: 'The microphone is busy',
  unsupported: 'This browser can’t use the microphone',
};

function bodyFor(problem: MicProblem, device: string): ReactNode {
  switch (problem) {
    case 'denied':
      return <>Your {device} said no. Here’s how to switch it on:</>;
    case 'dismissed':
      return (
        <>
          Tap <strong>Try again</strong>, then tap <strong>Allow</strong>. If the question doesn’t come back:
        </>
      );
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
      return <>Open this page in Safari on an iPhone, or in Chrome on an Android phone.</>;
  }
}

/** Where this browser keeps its microphone switch, one tap at a time. */
function stepsFor(env: BrowserInfo): ReactNode[] {
  const again = (
    <>
      Then tap <strong>Try again</strong>
    </>
  );
  if (env.os === 'ios' && env.browser === 'safari') {
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
  const problem = gate.problem ?? 'denied';
  const steps = problem === 'denied' || problem === 'dismissed';
  return (
    <div className={styles.mic} data-mic-view="recovery" data-problem={problem}>
      <Lyric text={TITLES[problem]} />
      <p className={styles.micBody}>{bodyFor(problem, deviceOf(env))}</p>
      {steps && (
        <ol className={styles.micSteps}>
          {stepsFor(env).map((step, i) => (
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
      <button type="button" className={styles.micButton} onClick={onAsk}>
        Try again
      </button>
      {/* Reloading is the quick fix on an iPhone, where Safari asks again after a reload, so it sits right under the main button. */}
      <button type="button" className={styles.micLink} onClick={onReload}>
        Reload this page
      </button>
      {steps && env.os === 'ios' && (
        <p className={styles.micNote}>{env.browser === 'safari' ? 'Safari' : 'Your browser'} may ask again each time you open this page. That’s normal.</p>
      )}
    </div>
  );
}
