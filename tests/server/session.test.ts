import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  clearCookie,
  parseCookies,
  readSessionUserId,
  serializeCookie,
  signSession,
  verifySession,
} from '../../src/lib/server/session';

const SECRET = 'test-secret-test-secret-test-secret';

describe('session cookie signing', () => {
  it('round-trips a user id', () => {
    const v = signSession('spotify:user.1', SECRET);
    expect(verifySession(v, SECRET)).toBe('spotify:user.1');
  });

  it('rejects tampering, other secrets and junk', () => {
    const v = signSession('alice', SECRET);
    const [payload, sig] = v.split('.') as [string, string];
    const forged = `${Buffer.from('mallory').toString('base64url')}.${sig}`;
    expect(verifySession(forged, SECRET)).toBeNull();
    const flipped = `${payload}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(verifySession(flipped, SECRET)).toBeNull();
    expect(verifySession(v, 'another-secret-another-secret')).toBeNull();
    for (const junk of [undefined, null, '', 'abc', '.', 'a.b.c', `${payload}.`]) {
      expect(verifySession(junk, SECRET)).toBeNull();
    }
  });

  it('refuses to sign without a secret', () => {
    expect(() => signSession('alice', '')).toThrow();
  });

  it('serializes httpOnly cookies and reads them back from a request', () => {
    const c = serializeCookie(SESSION_COOKIE, signSession('bob', SECRET), { maxAge: 60, secure: true });
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/Max-Age=60/);
    const pair = c.split(';')[0]!;
    const req = new Request('http://x/', { headers: { cookie: `other=1; ${pair}` } });
    expect(readSessionUserId(req, SECRET)).toBe('bob');
    expect(clearCookie(SESSION_COOKIE)).toMatch(/Max-Age=0/);
    expect(parseCookies('a=1; b=%20x; bad')).toEqual({ a: '1', b: ' x' });
  });
});
