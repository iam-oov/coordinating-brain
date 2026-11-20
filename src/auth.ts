import crypto from 'node:crypto';

import type { Db } from './db.ts';

/** Failed logins allowed per IP inside the window before it is blocked. */
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export interface User {
  id: number;
  name: string;
  email: string | null;
}

export interface Session {
  userId: number;
  isAdmin: boolean;
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

// ------------------------------------------------------------- tokens

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function createSession(
  db: Db,
  userId: number,
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
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.enabled = 1`,
    )
    .get(sha256(token), now) as { user_id: number; is_admin: number } | undefined;
  return row ? { userId: row.user_id, isAdmin: row.is_admin === 1 } : null;
}

export function deleteSession(db: Db, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

const OAUTH_STATE_MS = 10 * 60 * 1000;

export interface OAuthStart {
  state: string;
  verifier: string;
  nonce: string;
  browserToken: string;
}

export interface OAuthState {
  verifier: string;
  nonce: string;
  next: string;
  appSlug: string | null;
}

export function createOAuthState(db: Db, next: string, appSlug: string | null, now = Date.now()): OAuthStart {
  const start = { state: newToken(), verifier: newToken(), nonce: newToken(), browserToken: newToken() };
  db.prepare(
    `INSERT INTO oauth_states (state_hash, browser_hash, verifier, nonce, next, app_slug, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sha256(start.state), sha256(start.browserToken), start.verifier, start.nonce, next, appSlug, now + OAUTH_STATE_MS);
  db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now);
  return start;
}

/** Single use: the state is deleted whether or not it matches the browser. */
export function consumeOAuthState(
  db: Db,
  state: string,
  browserToken: string | undefined,
  now = Date.now(),
): OAuthState | null {
  const hash = sha256(state);
  const row = db
    .prepare('SELECT browser_hash, verifier, nonce, next, app_slug, expires_at FROM oauth_states WHERE state_hash = ?')
    .get(hash) as
    | { browser_hash: string; verifier: string; nonce: string; next: string; app_slug: string | null; expires_at: number }
    | undefined;
  if (!row) return null;
  db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(hash);
  if (row.expires_at < now || !browserToken || sha256(browserToken) !== row.browser_hash) return null;
  return { verifier: row.verifier, nonce: row.nonce, next: row.next, appSlug: row.app_slug };
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
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
