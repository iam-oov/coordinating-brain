import crypto from 'node:crypto';

import type { Db } from './db.ts';

/** Failed logins allowed per IP inside the window before it is blocked. */
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export const CODE_PATTERN = /^\d{4}$/;

export interface User {
  id: number;
  name: string;
}

export interface Session {
  userId: number | null;
  isAdmin: boolean;
}

// ---------------------------------------------------------------- codes

export function hashCode(code: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(code, salt, 32).toString('hex');
  return { salt, hash };
}

function codeMatches(code: string, salt: string, hash: string): boolean {
  const candidate = crypto.scryptSync(code, salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

/** The enabled user whose code is [code], or null. Codes are stored hashed. */
export function findUserByCode(db: Db, code: string): User | null {
  if (!CODE_PATTERN.test(code)) return null;
  const rows = db
    .prepare('SELECT id, name, code_salt, code_hash FROM users WHERE enabled = 1')
    .all() as { id: number; name: string; code_salt: string; code_hash: string }[];
  for (const r of rows) {
    if (codeMatches(code, r.code_salt, r.code_hash)) return { id: r.id, name: r.name };
  }
  return null;
}

/** A 4-digit code no other user has. */
export function generateUniqueCode(db: Db): string {
  for (let i = 0; i < 200; i++) {
    const code = crypto.randomInt(0, 10_000).toString().padStart(4, '0');
    if (!findUserByCode(db, code)) return code;
  }
  throw new Error('No free 4-digit code left');
}

// -------------------------------------------------------------- lockout

export function retryAfterSeconds(db: Db, ip: string, now = Date.now()): number {
  const rows = db
    .prepare('SELECT at FROM auth_failures WHERE ip = ? AND at > ? ORDER BY at ASC')
    .all(ip, now - LOCKOUT_MS) as { at: number }[];
  if (rows.length < MAX_FAILURES) return 0;
  // Blocked until the oldest failure that still counts leaves the window.
  const oldest = rows[rows.length - MAX_FAILURES].at;
  return Math.max(1, Math.ceil((oldest + LOCKOUT_MS - now) / 1000));
}

export function recordFailure(db: Db, ip: string, now = Date.now()): void {
  db.prepare('INSERT INTO auth_failures (ip, at) VALUES (?, ?)').run(ip, now);
  db.prepare('DELETE FROM auth_failures WHERE at < ?').run(now - 24 * 60 * 60 * 1000);
}

export function clearFailures(db: Db, ip: string): void {
  db.prepare('DELETE FROM auth_failures WHERE ip = ?').run(ip);
}

export type LoginResult =
  | { kind: 'ok'; user: User }
  | { kind: 'invalid' }
  | { kind: 'blocked'; retryAfter: number };

/**
 * Checks a 4-digit code. While an IP is blocked, even a correct code is
 * refused, so guessing all 10,000 codes takes years.
 */
export function loginWithCode(db: Db, code: string, ip: string, now = Date.now()): LoginResult {
  const wait = retryAfterSeconds(db, ip, now);
  if (wait > 0) return { kind: 'blocked', retryAfter: wait };
  const user = findUserByCode(db, code.trim());
  if (!user) {
    recordFailure(db, ip, now);
    const after = retryAfterSeconds(db, ip, now);
    return after > 0 ? { kind: 'blocked', retryAfter: after } : { kind: 'invalid' };
  }
  clearFailures(db, ip);
  return { kind: 'ok', user };
}

export function loginAdmin(
  db: Db,
  expected: string,
  given: string,
  ip: string,
  now = Date.now(),
): 'ok' | 'invalid' | 'disabled' | { retryAfter: number } {
  if (!expected) return 'disabled';
  const wait = retryAfterSeconds(db, ip, now);
  if (wait > 0) return { retryAfter: wait };
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  if (crypto.timingSafeEqual(a, b)) {
    clearFailures(db, ip);
    return 'ok';
  }
  recordFailure(db, ip, now);
  return 'invalid';
}

// ------------------------------------------------------------- tokens

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function createSession(
  db: Db,
  userId: number | null,
  isAdmin: boolean,
  days: number,
  now = Date.now(),
): string {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, is_admin, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    isAdmin ? 1 : 0,
    now + days * 24 * 60 * 60 * 1000,
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return token;
}

export function getSession(db: Db, token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.user_id, s.is_admin FROM sessions s
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND (s.user_id IS NULL OR u.enabled = 1)`,
    )
    .get(sha256(token), now) as { user_id: number | null; is_admin: number } | undefined;
  return row ? { userId: row.user_id, isAdmin: row.is_admin === 1 } : null;
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

/** One-time link to download an APK from a browser (valid 10 minutes). */
export function createDownloadToken(db: Db, userId: number, appSlug: string, now = Date.now()): string {
  const token = newToken();
  db.prepare('INSERT INTO download_tokens (token_hash, user_id, app_slug, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    appSlug,
    now + 10 * 60 * 1000,
  );
  db.prepare('DELETE FROM download_tokens WHERE expires_at < ?').run(now);
  return token;
}

/** Consumes a download token; returns the user it was issued to. */
export function useDownloadToken(db: Db, token: string, appSlug: string, now = Date.now()): number | null {
  const hash = sha256(token);
  const row = db
    .prepare('SELECT user_id FROM download_tokens WHERE token_hash = ? AND app_slug = ? AND expires_at > ?')
    .get(hash, appSlug, now) as { user_id: number } | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM download_tokens WHERE token_hash = ?').run(hash);
  return row.user_id;
}
