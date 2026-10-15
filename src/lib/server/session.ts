// Signed session cookie: value is "<base64url(userId)>.<base64url(HMAC-SHA256(secret, payload))>".
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'kd_session';
export const STATE_COOKIE = 'kd_oauth_state';
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const mac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest();

export function signSession(userId: string, secret: string): string {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const payload = b64url(userId);
  return `${payload}.${b64url(mac(secret, payload))}`;
}

/** Returns the user id, or null when the value is missing, malformed or tampered with. */
export function verifySession(value: string | undefined | null, secret: string): string | null {
  if (!value || !secret) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const payload = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = mac(secret, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const userId = Buffer.from(payload, 'base64url').toString('utf8');
  return userId || null;
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAge?: number;
  secure?: boolean;
}

/** httpOnly, SameSite=Lax (so it rides along on the Spotify redirect back), Path=/. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie(name: string, opts: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...opts, maxAge: 0 });
}

export function readSessionUserId(req: Request, secret: string): string | null {
  return verifySession(parseCookies(req.headers.get('cookie'))[SESSION_COOKIE], secret);
}
