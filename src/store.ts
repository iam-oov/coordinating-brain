import type { Db } from './db.ts';
import { tx } from './db.ts';
import type { User } from './auth.ts';
import type { GoogleIdentity } from './google.ts';
import { moderate } from './worker/moderation.ts';

export interface App {
  slug: string;
  name: string;
  repoUrl: string;
  branch: string;
  allowedPaths: string[];
  testCmd: string;
  buildCmd: string;
  apkPath: string;
}

export type RequestStatus =
  | 'pending' // waiting for the admin
  | 'approved' // queued for the worker
  | 'rejected' // the admin said no
  | 'running'
  | 'built' // committed, pushed and APK published
  | 'failed' // could not be built or verified
  | 'discarded'; // the AI or a check refused it

export interface Request {
  id: number;
  appSlug: string;
  userId: number | null;
  userName: string | null;
  kind: 'change' | 'revert';
  text: string;
  revertSha: string | null;
  status: RequestStatus;
  flags: string[];
  reason: string | null;
  log: string;
  createdAt: number;
  decidedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Build {
  id: number;
  requestId: number;
  appSlug: string;
  versionCode: number;
  apkFile: string;
  commitSha: string;
  createdAt: number;
}

/** Statuses that block a user from sending another request to the same app. */
const OPEN = ['pending', 'approved', 'running'];

// ----------------------------------------------------------------- apps

type AppRow = {
  slug: string;
  name: string;
  repo_url: string;
  branch: string;
  allowed_paths: string;
  test_cmd: string;
  build_cmd: string;
  apk_path: string;
};

function toApp(r: AppRow): App {
  return {
    slug: r.slug,
    name: r.name,
    repoUrl: r.repo_url,
    branch: r.branch,
    allowedPaths: JSON.parse(r.allowed_paths) as string[],
    testCmd: r.test_cmd,
    buildCmd: r.build_cmd,
    apkPath: r.apk_path,
  };
}

export function upsertApp(db: Db, app: App, now = Date.now()): void {
  db.prepare(
    `INSERT INTO apps (slug, name, repo_url, branch, allowed_paths, test_cmd, build_cmd, apk_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name = excluded.name, repo_url = excluded.repo_url,
       branch = excluded.branch, allowed_paths = excluded.allowed_paths, test_cmd = excluded.test_cmd,
       build_cmd = excluded.build_cmd, apk_path = excluded.apk_path`,
  ).run(
    app.slug,
    app.name,
    app.repoUrl,
    app.branch,
    JSON.stringify(app.allowedPaths),
    app.testCmd,
    app.buildCmd,
    app.apkPath,
    now,
  );
}

export function getApp(db: Db, slug: string): App | null {
  const r = db.prepare('SELECT * FROM apps WHERE slug = ?').get(slug) as AppRow | undefined;
  return r ? toApp(r) : null;
}

export function listApps(db: Db): App[] {
  return (db.prepare('SELECT * FROM apps ORDER BY name').all() as AppRow[]).map(toApp);
}

/** Apps the user may see and send requests to. */
export function appsForUser(db: Db, userId: number): App[] {
  return (
    db
      .prepare(
        `SELECT a.* FROM apps a JOIN user_apps ua ON ua.app_slug = a.slug
         WHERE ua.user_id = ? ORDER BY a.name`,
      )
      .all(userId) as AppRow[]
  ).map(toApp);
}

export function userCanUseApp(db: Db, userId: number, slug: string): boolean {
  return !!db.prepare('SELECT 1 FROM user_apps WHERE user_id = ? AND app_slug = ?').get(userId, slug);
}

// ---------------------------------------------------------------- users

export type GoogleUserResult = { ok: true; user: User; created: boolean } | { ok: false; error: 'admin-unlinked' | 'disabled' };

type UserRow = { id: number; name: string; email: string | null; google_sub: string | null; enabled: number };

/**
 * Finds the user for a Google account: by subject, else a legacy user with the
 * same email and no subject yet (which gets linked), else a new user. An admin
 * email that matches no user is refused while unlinked legacy users exist, so
 * the admin is linked with `user:link` instead of getting a duplicate account.
 */
export function upsertGoogleUser(
  db: Db,
  identity: GoogleIdentity,
  isAdmin: boolean,
  now = Date.now(),
): GoogleUserResult {
  return tx(db, () => {
    const bySub = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(identity.sub) as UserRow | undefined;
    const byEmail = bySub
      ? undefined
      : (db.prepare('SELECT * FROM users WHERE email = ? AND google_sub IS NULL').get(identity.email) as UserRow | undefined);
    const existing = bySub ?? byEmail;
    if (existing) {
      if (existing.enabled !== 1) return { ok: false, error: 'disabled' };
      db.prepare('UPDATE users SET google_sub = ?, email = ? WHERE id = ?').run(identity.sub, identity.email, existing.id);
      return { ok: true, created: false, user: { id: existing.id, name: existing.name, email: identity.email } };
    }
    if (isAdmin && db.prepare('SELECT 1 FROM users WHERE email IS NULL').get()) return { ok: false, error: 'admin-unlinked' };
    const res = db
      .prepare('INSERT INTO users (name, email, google_sub, created_at) VALUES (?, ?, ?, ?)')
      .run(identity.name, identity.email, identity.sub, now);
    return { ok: true, created: true, user: { id: Number(res.lastInsertRowid), name: identity.name, email: identity.email } };
  });
}

export function getUser(db: Db, id: number): User | null {
  const r = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id) as User | undefined;
  return r ?? null;
}

export function linkUserEmail(db: Db, name: string, email: string): void {
  const res = db.prepare('UPDATE users SET email = ? WHERE name = ?').run(email.trim().toLowerCase(), name);
  if (res.changes === 0) throw new Error(`No user named ${name}`);
}

export function userBranch(uid: number): string {
  return `users/${uid}`;
}

export function userId(db: Db, name: string): number {
  const r = db.prepare('SELECT id FROM users WHERE name = ?').get(name) as { id: number } | undefined;
  if (!r) throw new Error(`No user named ${name}`);
  return r.id;
}

export function grantApps(db: Db, uid: number, slugs: string[]): void {
  for (const s of slugs) {
    if (!getApp(db, s)) throw new Error(`No app ${s}`);
    db.prepare('INSERT OR IGNORE INTO user_apps (user_id, app_slug) VALUES (?, ?)').run(uid, s);
  }
}

export function revokeApps(db: Db, uid: number, slugs: string[]): void {
  for (const s of slugs) db.prepare('DELETE FROM user_apps WHERE user_id = ? AND app_slug = ?').run(uid, s);
}

export function setUserEnabled(db: Db, name: string, enabled: boolean): void {
  db.prepare('UPDATE users SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
}

export function listUsers(
  db: Db,
): { id: number; name: string; email: string | null; enabled: boolean; apps: string[] }[] {
  const users = db.prepare('SELECT id, name, email, enabled FROM users ORDER BY id').all() as {
    id: number;
    name: string;
    email: string | null;
    enabled: number;
  }[];
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    enabled: u.enabled === 1,
    apps: (
      db.prepare('SELECT app_slug FROM user_apps WHERE user_id = ? ORDER BY app_slug').all(u.id) as {
        app_slug: string;
      }[]
    ).map((r) => r.app_slug),
  }));
}

// ------------------------------------------------------------- requests

type RequestRow = {
  id: number;
  app_slug: string;
  user_id: number | null;
  user_name: string | null;
  kind: 'change' | 'revert';
  text: string;
  revert_sha: string | null;
  status: RequestStatus;
  flags: string | null;
  reason: string | null;
  log: string;
  created_at: number;
  decided_at: number | null;
  started_at: number | null;
  finished_at: number | null;
};

const REQUEST_SELECT = `SELECT r.*, u.name AS user_name FROM requests r LEFT JOIN users u ON u.id = r.user_id`;

function toRequest(r: RequestRow): Request {
  return {
    id: r.id,
    appSlug: r.app_slug,
    userId: r.user_id,
    userName: r.user_name,
    kind: r.kind,
    text: r.text,
    revertSha: r.revert_sha,
    status: r.status,
    flags: r.flags ? (JSON.parse(r.flags) as string[]) : [],
    reason: r.reason,
    log: r.log,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export type CreateRequestResult = { ok: true; request: Request } | { ok: false; error: string };

export function createRequest(
  db: Db,
  uid: number,
  appSlug: string,
  text: string,
  now = Date.now(),
): CreateRequestResult {
  const m = moderate(text);
  if (m.reject) return { ok: false, error: m.reject };
  const open = db
    .prepare(
      `SELECT 1 FROM requests WHERE user_id = ? AND app_slug = ? AND status IN (${OPEN.map(() => '?').join(',')})`,
    )
    .get(uid, appSlug, ...OPEN);
  if (open) return { ok: false, error: 'Ya tienes una solicitud en curso para esta app. Espera a que termine.' };
  const res = db
    .prepare('INSERT INTO requests (app_slug, user_id, text, flags, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(appSlug, uid, text.trim(), m.flags.length ? JSON.stringify(m.flags) : null, now);
  return { ok: true, request: getRequest(db, Number(res.lastInsertRowid))! };
}

/** A revert job created by the admin; approved right away. */
export function createRevertRequest(db: Db, build: Build, now = Date.now()): Request {
  const res = db
    .prepare(
      `INSERT INTO requests (app_slug, user_id, kind, text, revert_sha, status, created_at, decided_at)
       VALUES (?, NULL, 'revert', ?, ?, 'approved', ?, ?)`,
    )
    .run(build.appSlug, `Revertir build v${build.versionCode} (${build.commitSha.slice(0, 7)})`, build.commitSha, now, now);
  return getRequest(db, Number(res.lastInsertRowid))!;
}

export function getRequest(db: Db, id: number): Request | null {
  const r = db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) as RequestRow | undefined;
  return r ? toRequest(r) : null;
}

export function listRequests(db: Db, filter: { userId?: number; appSlug?: string; limit?: number } = {}): Request[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.userId !== undefined) {
    where.push('r.user_id = ?');
    args.push(filter.userId);
  }
  if (filter.appSlug !== undefined) {
    where.push('r.app_slug = ?');
    args.push(filter.appSlug);
  }
  const sql = `${REQUEST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ?`;
  return (db.prepare(sql).all(...args, filter.limit ?? 50) as RequestRow[]).map(toRequest);
}

/** Admin decision on a pending request. Returns false if it was not pending. */
export function decideRequest(
  db: Db,
  id: number,
  approve: boolean,
  reason: string | null,
  now = Date.now(),
): boolean {
  const res = db
    .prepare(`UPDATE requests SET status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
    .run(approve ? 'approved' : 'rejected', reason, now, id);
  return res.changes === 1;
}

/** Takes the oldest approved request and marks it running. */
export function claimNextApproved(db: Db, now = Date.now()): Request | null {
  return tx(db, () => {
    const r = db
      .prepare(`SELECT id FROM requests WHERE status = 'approved' ORDER BY id LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!r) return null;
    db.prepare(`UPDATE requests SET status = 'running', started_at = ? WHERE id = ?`).run(now, r.id);
    return getRequest(db, r.id);
  });
}

/** On startup: anything left 'running' by a crash goes back to the queue. */
export function requeueStuck(db: Db): number {
  return Number(db.prepare(`UPDATE requests SET status = 'approved', started_at = NULL WHERE status = 'running'`).run().changes);
}

const MAX_LOG = 20_000;

export function appendLog(db: Db, id: number, line: string): void {
  const r = db.prepare('SELECT log FROM requests WHERE id = ?').get(id) as { log: string } | undefined;
  if (!r) return;
  let log = `${r.log}${new Date().toISOString()} ${line}\n`;
  if (log.length > MAX_LOG) log = `…\n${log.slice(-MAX_LOG)}`;
  db.prepare('UPDATE requests SET log = ? WHERE id = ?').run(log, id);
}

export function finishRequest(
  db: Db,
  id: number,
  status: 'built' | 'failed' | 'discarded',
  reason: string | null,
  now = Date.now(),
): void {
  db.prepare('UPDATE requests SET status = ?, reason = ?, finished_at = ? WHERE id = ?').run(status, reason, now, id);
}

// --------------------------------------------------------------- builds

type BuildRow = {
  id: number;
  request_id: number;
  app_slug: string;
  version_code: number;
  apk_file: string;
  commit_sha: string;
  created_at: number;
};

function toBuild(r: BuildRow): Build {
  return {
    id: r.id,
    requestId: r.request_id,
    appSlug: r.app_slug,
    versionCode: r.version_code,
    apkFile: r.apk_file,
    commitSha: r.commit_sha,
    createdAt: r.created_at,
  };
}

export function addBuild(db: Db, b: Omit<Build, 'id' | 'createdAt'>, now = Date.now()): Build {
  const res = db
    .prepare(
      'INSERT INTO builds (request_id, app_slug, version_code, apk_file, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(b.requestId, b.appSlug, b.versionCode, b.apkFile, b.commitSha, now);
  return { ...b, id: Number(res.lastInsertRowid), createdAt: now };
}

export function importBuild(
  db: Db,
  b: Omit<Build, 'id' | 'createdAt' | 'requestId'>,
  now = Date.now(),
): Build {
  return tx(db, () => {
    const res = db
      .prepare(
        `INSERT INTO requests (app_slug, user_id, kind, text, status, reason, created_at, decided_at, started_at, finished_at)
         VALUES (?, NULL, 'change', ?, 'built', ?, ?, ?, ?, ?)`,
      )
      .run(b.appSlug, `Imported build v${b.versionCode}`, 'Built outside the worker.', now, now, now, now);
    return addBuild(db, { ...b, requestId: Number(res.lastInsertRowid) }, now);
  });
}

export function latestBuild(db: Db, appSlug: string): Build | null {
  const r = db.prepare('SELECT * FROM builds WHERE app_slug = ? ORDER BY id DESC LIMIT 1').get(appSlug) as
    | BuildRow
    | undefined;
  return r ? toBuild(r) : null;
}

export function getBuild(db: Db, id: number): Build | null {
  const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as BuildRow | undefined;
  return r ? toBuild(r) : null;
}

export function buildForRequest(db: Db, requestId: number): Build | null {
  const r = db.prepare('SELECT * FROM builds WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId) as
    | BuildRow
    | undefined;
  return r ? toBuild(r) : null;
}

export function listBuilds(db: Db, appSlug: string, limit = 20): Build[] {
  return (
    db.prepare('SELECT * FROM builds WHERE app_slug = ? ORDER BY id DESC LIMIT ?').all(appSlug, limit) as BuildRow[]
  ).map(toBuild);
}

export function maxVersionCode(db: Db, appSlug: string): number {
  const r = db.prepare('SELECT MAX(version_code) AS v FROM builds WHERE app_slug = ?').get(appSlug) as {
    v: number | null;
  };
  return r.v ?? 0;
}
