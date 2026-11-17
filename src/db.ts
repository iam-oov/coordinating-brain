import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/**
 * Schema. Timestamps are epoch milliseconds (INTEGER).
 *
 * - apps: one row per app the brain can change (repo, allowed paths, commands).
 * - users / user_apps: who can send requests, and to which apps.
 * - requests: improvement requests and their lifecycle.
 * - builds: every published APK, linked to the commit that produced it.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS apps (
  slug          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_url      TEXT NOT NULL,
  branch        TEXT NOT NULL DEFAULT 'main',
  allowed_paths TEXT NOT NULL,          -- JSON array of path prefixes
  test_cmd      TEXT NOT NULL,
  build_cmd     TEXT NOT NULL,
  apk_path      TEXT NOT NULL,          -- relative to the repo root
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  code_salt  TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_apps (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_slug TEXT NOT NULL REFERENCES apps(slug) ON DELETE CASCADE,
  PRIMARY KEY (user_id, app_slug)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS download_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_slug   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_failures (
  id INTEGER PRIMARY KEY,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_failures_ip ON auth_failures(ip, at);

CREATE TABLE IF NOT EXISTS requests (
  id          INTEGER PRIMARY KEY,
  app_slug    TEXT NOT NULL REFERENCES apps(slug),
  user_id     INTEGER REFERENCES users(id),
  kind        TEXT NOT NULL DEFAULT 'change',   -- 'change' | 'revert'
  text        TEXT NOT NULL,
  revert_sha  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  flags       TEXT,                             -- heuristic warnings shown to the admin
  reason      TEXT,
  log         TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status, id);

CREATE TABLE IF NOT EXISTS builds (
  id           INTEGER PRIMARY KEY,
  request_id   INTEGER NOT NULL REFERENCES requests(id),
  app_slug     TEXT NOT NULL REFERENCES apps(slug),
  version_code INTEGER NOT NULL,
  apk_file     TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Runs [fn] inside a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
