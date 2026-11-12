import { describe, expect, it } from 'vitest';
import { POSTHOG_PROXY_PATH } from '../../src/lib/postHogProxy';
import { postHogSettings, postHogUpstream } from '../../src/lib/server/config';

const KEY = 'phc_AbCdEf0123456789AbCdEf0123456789AbCdEf0123';
const env = { NEXT_PUBLIC_POSTHOG_KEY: KEY, NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com' };

describe('postHogSettings (QWW-51, QWW-63)', () => {
  it('reads the key from the environment, and says where this build runs', () => {
    expect(postHogSettings(env)).toEqual({ key: KEY, host: POSTHOG_PROXY_PATH, uiHost: 'https://us.posthog.com', environment: 'local' });
    expect(postHogSettings({ ...env, VERCEL_ENV: 'production' })?.environment).toBe('production');
    expect(postHogSettings({ ...env, VERCEL_ENV: 'preview' })?.environment).toBe('preview');
  });

  it('counts anything else as local, so only a real deployment is ever "production"', () => {
    for (const value of [undefined, '', 'development', 'Production', 'prod']) {
      expect(postHogSettings({ ...env, VERCEL_ENV: value })?.environment).toBe('local');
    }
  });

  it('is null, and the app records to our own log alone, when the key or host is missing', () => {
    expect(postHogSettings({})).toBeNull();
    expect(postHogSettings({ NEXT_PUBLIC_POSTHOG_KEY: KEY })).toBeNull();
    expect(postHogSettings({ NEXT_PUBLIC_POSTHOG_HOST: env.NEXT_PUBLIC_POSTHOG_HOST })).toBeNull();
    expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_KEY: '' })).toBeNull();
    expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: '   ' })).toBeNull();
  });

  it('never hands a browser anything but a project token: a personal or secret key is refused', () => {
    for (const key of ['phx_AbCdEf0123456789', 'phs_AbCdEf0123456789', 'AbCdEf0123456789', 'phc_', 'phc_has space', 'phc_a;b']) {
      expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_KEY: key }), key).toBeNull();
    }
  });

  it('sends the browser to our own path, whatever the host is: it never learns PostHog\'s address', () => {
    for (const host of ['https://us.i.posthog.com', 'https://eu.i.posthog.com', 'https://posthog.example.com/some/path', 'http://127.0.0.1:4010']) {
      const settings = postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host });
      expect(settings?.host, host).toBe(POSTHOG_PROXY_PATH);
      expect(settings?.host.startsWith('/') && !settings.host.startsWith('//'), host).toBe(true);
    }
  });

  it('points the library at PostHog\'s own app, for the links back to it: us or eu by the host', () => {
    const uiHost = (host: string) => postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host })?.uiHost;
    expect(uiHost('https://us.i.posthog.com')).toBe('https://us.posthog.com');
    expect(uiHost('https://eu.i.posthog.com/')).toBe('https://eu.posthog.com');
    expect(uiHost(' https://eu.i.posthog.com ')).toBe('https://eu.posthog.com');
  });

  it('takes only an https host (or http on this machine), and nothing else', () => {
    for (const host of ['https://us.i.posthog.com', ' https://eu.i.posthog.com ', 'http://127.0.0.1:4010', 'http://localhost:4010', 'http://[::1]:4010']) {
      expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host }), host).not.toBeNull();
    }
    for (const host of ['http://us.i.posthog.com', 'http://192.168.1.20:4010', 'us.i.posthog.com', 'ftp://x.test', 'javascript:alert(1)', 'not a url']) {
      expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host }), host).toBeNull();
      expect(postHogUpstream({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host }), host).toBeNull();
    }
  });

  it('trims the key, as a pasted value often carries a newline', () => {
    expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_KEY: `${KEY}\n` })?.key).toBe(KEY);
  });

  it('reaches the page as a prop, read at request time', async () => {
    const { default: Home } = await import('../../app/page');
    const names = ['NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_POSTHOG_HOST', 'VERCEL_ENV'] as const;
    const was = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      expect(Home().props.postHog).toBeNull();
      process.env.NEXT_PUBLIC_POSTHOG_KEY = KEY;
      process.env.NEXT_PUBLIC_POSTHOG_HOST = 'https://us.i.posthog.com';
      process.env.VERCEL_ENV = 'preview';
      expect(Home().props.postHog).toEqual({ key: KEY, host: POSTHOG_PROXY_PATH, uiHost: 'https://us.posthog.com', environment: 'preview' });
      // Read again on the next request, not fixed when the module loaded.
      process.env.VERCEL_ENV = 'production';
      expect(Home().props.postHog?.environment).toBe('production');
      process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phx_notaprojecttoken';
      expect(Home().props.postHog).toBeNull();
    } finally {
      for (const name of names) {
        const value = was[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('postHogUpstream (QWW-63): where the proxy forwards to', () => {
  const upstream = (host: string) => postHogUpstream({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host });

  it('is PostHog\'s ingest host for events, and its asset host for scripts and config, per region', () => {
    expect(upstream('https://us.i.posthog.com')).toEqual({ api: 'https://us.i.posthog.com', assets: 'https://us-assets.i.posthog.com' });
    expect(upstream('https://eu.i.posthog.com/')).toEqual({ api: 'https://eu.i.posthog.com', assets: 'https://eu-assets.i.posthog.com' });
  });

  it('serves both from one host when it is not PostHog\'s cloud: a self-hosted PostHog, or the stand-in in e2e', () => {
    expect(upstream('https://posthog.example.com')).toEqual({ api: 'https://posthog.example.com', assets: 'https://posthog.example.com' });
    expect(upstream('http://127.0.0.1:4010')).toEqual({ api: 'http://127.0.0.1:4010', assets: 'http://127.0.0.1:4010' });
  });

  it('keeps only the origin: a path, query or fragment is dropped', () => {
    expect(upstream('https://us.i.posthog.com/ingest?x=1#top')?.api).toBe('https://us.i.posthog.com');
    expect(upstream('https://user:secret@us.i.posthog.com/')?.api).toBe('https://us.i.posthog.com');
  });

  it('is null, so the proxy answers 404, exactly when PostHog is off', () => {
    expect(postHogUpstream({})).toBeNull();
    expect(postHogUpstream({ NEXT_PUBLIC_POSTHOG_KEY: KEY })).toBeNull();
    expect(postHogUpstream({ NEXT_PUBLIC_POSTHOG_HOST: env.NEXT_PUBLIC_POSTHOG_HOST })).toBeNull();
    expect(postHogUpstream({ ...env, NEXT_PUBLIC_POSTHOG_KEY: 'phx_notaprojecttoken' })).toBeNull();
  });
});
