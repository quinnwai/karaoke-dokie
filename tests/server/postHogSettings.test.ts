import { describe, expect, it } from 'vitest';
import { postHogSettings } from '../../src/lib/server/config';

const KEY = 'phc_AbCdEf0123456789AbCdEf0123456789AbCdEf0123';
const env = { NEXT_PUBLIC_POSTHOG_KEY: KEY, NEXT_PUBLIC_POSTHOG_HOST: 'https://us.i.posthog.com' };

describe('postHogSettings (QWW-51)', () => {
  it('reads the key and host from the environment, and says where this build runs', () => {
    expect(postHogSettings(env)).toEqual({ key: KEY, host: 'https://us.i.posthog.com', environment: 'local' });
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

  it('takes only an https host, and tidies it to its origin', () => {
    expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com/' })?.host).toBe('https://eu.i.posthog.com');
    expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: ' https://eu.i.posthog.com ' })?.host).toBe('https://eu.i.posthog.com');
    for (const host of ['http://us.i.posthog.com', 'us.i.posthog.com', 'ftp://x.test', 'javascript:alert(1)', 'not a url']) {
      expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_HOST: host }), host).toBeNull();
    }
  });

  it('trims the key, as a pasted value often carries a newline', () => {
    expect(postHogSettings({ ...env, NEXT_PUBLIC_POSTHOG_KEY: `${KEY}\n` })?.key).toBe(KEY);
  });
});
