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
  protectedPaths: string[];
  prepareCmd: string;
  testCmd: string;
  buildCmd: string;
  apkPath: string;
}

export type RequestStatus =
  | 'pending' // waiting for the admin
  | 'approved' // queued for the worker
  | 'rejected' // the admin said no
  | 'running'
  | 'review'
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
  branch: string;
  alsoMain: boolean;
  mainSha: string | null;
  branchSha: string | null;
  forced: boolean;
  reviewOk: boolean;
  reviewPatch: string | null;
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
  branch: string;
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
  protected_paths: string;
  prepare_cmd: string;
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
    protectedPaths: JSON.parse(r.protected_paths) as string[],
    prepareCmd: r.prepare_cmd,
    testCmd: r.test_cmd,
    buildCmd: r.build_cmd,
    apkPath: r.apk_path,
  };
}

export function upsertApp(db: Db, app: App, now = Date.now()): void {
  db.prepare(
    `INSERT INTO apps (slug, name, repo_url, branch, allowed_paths, protected_paths, prepare_cmd, test_cmd, build_cmd, apk_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET name = excluded.name, repo_url = excluded.repo_url,
       branch = excluded.branch, allowed_paths = excluded.allowed_paths, protected_paths = excluded.protected_paths,
       prepare_cmd = excluded.prepare_cmd, test_cmd = excluded.test_cmd,
       build_cmd = excluded.build_cmd, apk_path = excluded.apk_path`,
  ).run(
    app.slug,
    app.name,
    app.repoUrl,
    app.branch,
    JSON.stringify(app.allowedPaths),
    JSON.stringify(app.protectedPaths),
    app.prepareCmd,
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
         WHERE ua.user_id = ?
         ORDER BY ua.favorite DESC,
           (SELECT MAX(r.created_at) FROM requests r WHERE r.user_id = ua.user_id AND r.app_slug = a.slug) DESC,
           a.name`,
      )
      .all(userId) as AppRow[]
  ).map(toApp);
}

export function favoriteApps(db: Db, userId: number): Set<string> {
  const rows = db.prepare('SELECT app_slug FROM user_apps WHERE user_id = ? AND favorite = 1').all(userId) as {
    app_slug: string;
  }[];
  return new Set(rows.map((r) => r.app_slug));
}

export function setFavorite(db: Db, userId: number, slug: string, favorite: boolean): boolean {
  const res = db
    .prepare('UPDATE user_apps SET favorite = ? WHERE user_id = ? AND app_slug = ?')
    .run(favorite ? 1 : 0, userId, slug);
  return res.changes === 1;
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
  branch: string;
  also_main: number;
  main_sha: string | null;
  branch_sha: string | null;
  forced: number;
  review_ok: number;
  review_patch: string | null;
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
    branch: r.branch,
    alsoMain: r.also_main === 1,
    mainSha: r.main_sha,
    branchSha: r.branch_sha,
    forced: r.forced === 1,
    reviewOk: r.review_ok === 1,
    reviewPatch: r.review_patch,
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
    .prepare('INSERT INTO requests (app_slug, user_id, text, flags, branch, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(appSlug, uid, text.trim(), m.flags.length ? JSON.stringify(m.flags) : null, userBranch(uid), now);
  return { ok: true, request: getRequest(db, Number(res.lastInsertRowid))! };
}

/** A revert job created by the admin; approved right away. */
export function createRevertRequest(db: Db, build: Build, now = Date.now()): Request {
  const res = db
    .prepare(
      `INSERT INTO requests (app_slug, user_id, kind, text, revert_sha, branch, status, created_at, decided_at)
       VALUES (?, NULL, 'revert', ?, ?, ?, 'approved', ?, ?)`,
    )
    .run(
      build.appSlug,
      `Revertir build v${build.versionCode} (${build.commitSha.slice(0, 7)}) de ${build.branch}`,
      build.commitSha,
      build.branch,
      now,
      now,
    );
  return getRequest(db, Number(res.lastInsertRowid))!;
}

export function getRequest(db: Db, id: number): Request | null {
  const r = db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`).get(id) as RequestRow | undefined;
  return r ? toRequest(r) : null;
}

export interface RequestFilter {
  userId?: number;
  appSlug?: string;
  statuses?: RequestStatus[];
  limit?: number;
  offset?: number;
}

function requestWhere(filter: RequestFilter): { sql: string; args: (string | number)[] } {
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
  if (filter.statuses?.length) {
    where.push(`r.status IN (${filter.statuses.map(() => '?').join(',')})`);
    args.push(...filter.statuses);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export function listRequests(db: Db, filter: RequestFilter = {}): Request[] {
  const w = requestWhere(filter);
  const sql = `${REQUEST_SELECT} ${w.sql} ORDER BY r.id DESC LIMIT ? OFFSET ?`;
  return (db.prepare(sql).all(...w.args, filter.limit ?? 50, filter.offset ?? 0) as RequestRow[]).map(toRequest);
}

export function countRequests(db: Db, filter: RequestFilter = {}): number {
  const w = requestWhere(filter);
  return (db.prepare(`SELECT COUNT(*) AS n FROM requests r ${w.sql}`).get(...w.args) as { n: number }).n;
}

export interface Decision {
  approve: boolean;
  reason?: string | null;
  alsoMain?: boolean;
  now?: number;
}

/** Admin decision on a pending request. Returns false if it was not pending. */
export function decideRequest(db: Db, id: number, d: Decision): boolean {
  const res = db
    .prepare(
      `UPDATE requests SET status = ?, reason = ?, also_main = ?, decided_at = ? WHERE id = ? AND status = 'pending'`,
    )
    .run(d.approve ? 'approved' : 'rejected', d.reason ?? null, d.approve && d.alsoMain ? 1 : 0, d.now ?? Date.now(), id);
  return res.changes === 1;
}

export function forceRequest(db: Db, id: number, now = Date.now()): boolean {
  const res = db
    .prepare(
      `UPDATE requests SET status = 'approved', forced = 1, review_ok = 0, review_patch = NULL, main_sha = NULL,
         branch_sha = NULL, reason = NULL, decided_at = ?, started_at = NULL, finished_at = NULL
       WHERE id = ? AND kind = 'change' AND status IN ('failed', 'discarded')`,
    )
    .run(now, id);
  return res.changes === 1;
}

export function saveReview(db: Db, id: number, patch: string, summary: string, now = Date.now()): void {
  db.prepare(`UPDATE requests SET status = 'review', review_patch = ?, reason = ?, finished_at = ? WHERE id = ?`).run(
    patch,
    summary,
    now,
    id,
  );
}

export function decideReview(db: Db, id: number, publish: boolean, now = Date.now()): boolean {
  const res = publish
    ? db
        .prepare(`UPDATE requests SET status = 'approved', review_ok = 1, decided_at = ?, finished_at = NULL WHERE id = ? AND status = 'review'`)
        .run(now, id)
    : db
        .prepare(`UPDATE requests SET status = 'discarded', reason = 'Descartada en la revisión del admin.', finished_at = ? WHERE id = ? AND status = 'review'`)
        .run(now, id);
  return res.changes === 1;
}

export function recordPushedSha(db: Db, id: number, target: 'main' | 'branch', sha: string): void {
  const column = target === 'main' ? 'main_sha' : 'branch_sha';
  db.prepare(`UPDATE requests SET ${column} = ? WHERE id = ?`).run(sha, id);
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
  branch: string;
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
    branch: r.branch,
    versionCode: r.version_code,
    apkFile: r.apk_file,
    commitSha: r.commit_sha,
    createdAt: r.created_at,
  };
}

export function addBuild(db: Db, b: Omit<Build, 'id' | 'createdAt'>, now = Date.now()): Build {
  const res = db
    .prepare(
      'INSERT INTO builds (request_id, app_slug, branch, version_code, apk_file, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(b.requestId, b.appSlug, b.branch, b.versionCode, b.apkFile, b.commitSha, now);
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
        `INSERT INTO requests (app_slug, user_id, kind, text, branch, status, reason, created_at, decided_at, started_at, finished_at)
         VALUES (?, NULL, 'change', ?, ?, 'built', ?, ?, ?, ?, ?)`,
      )
      .run(b.appSlug, `Imported build v${b.versionCode}`, b.branch, 'Built outside the worker.', now, now, now, now);
    return addBuild(db, { ...b, requestId: Number(res.lastInsertRowid) }, now);
  });
}

export function latestBuild(db: Db, appSlug: string): Build | null {
  const r = db.prepare('SELECT * FROM builds WHERE app_slug = ? ORDER BY id DESC LIMIT 1').get(appSlug) as
    | BuildRow
    | undefined;
  return r ? toBuild(r) : null;
}

export function latestBuildOn(db: Db, appSlug: string, branch: string): Build | null {
  const r = db
    .prepare('SELECT * FROM builds WHERE app_slug = ? AND branch = ? ORDER BY id DESC LIMIT 1')
    .get(appSlug, branch) as BuildRow | undefined;
  return r ? toBuild(r) : null;
}

export function latestBuildFor(db: Db, app: App, uid: number): Build | null {
  return latestBuildOn(db, app.slug, userBranch(uid));
}

export function getBuild(db: Db, id: number): Build | null {
  const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as BuildRow | undefined;
  return r ? toBuild(r) : null;
}

export function buildForRequest(db: Db, requestId: number, branch?: string): Build | null {
  const r = (
    branch === undefined
      ? db.prepare('SELECT * FROM builds WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId)
      : db.prepare('SELECT * FROM builds WHERE request_id = ? AND branch = ? ORDER BY id DESC LIMIT 1').get(requestId, branch)
  ) as BuildRow | undefined;
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
