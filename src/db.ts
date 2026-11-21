import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export const SCHEMA = `
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

const GOOGLE_AUTH_AND_BRANCHES = `
CREATE TABLE users_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE,
  google_sub TEXT UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
INSERT INTO users_new (id, name, enabled, created_at) SELECT id, name, enabled, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

DELETE FROM sessions WHERE user_id IS NULL;

ALTER TABLE requests ADD COLUMN branch     TEXT NOT NULL DEFAULT 'main';
ALTER TABLE requests ADD COLUMN also_main  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN main_sha   TEXT;
ALTER TABLE requests ADD COLUMN branch_sha TEXT;

ALTER TABLE builds ADD COLUMN branch TEXT NOT NULL DEFAULT 'main';
CREATE INDEX builds_branch ON builds(app_slug, branch, id);

ALTER TABLE apps ADD COLUMN protected_paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE apps ADD COLUMN prepare_cmd     TEXT NOT NULL DEFAULT '';

CREATE TABLE oauth_states (
  state_hash   TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier     TEXT NOT NULL,
  nonce        TEXT NOT NULL,
  next         TEXT NOT NULL,
  app_slug     TEXT,
  expires_at   INTEGER NOT NULL
);
`;

const FORCED_REQUESTS = `
ALTER TABLE requests ADD COLUMN forced       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN review_ok    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN review_patch TEXT;
`;

const FAVORITE_APPS = `
ALTER TABLE user_apps ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
`;

interface Migration {
  sql: string;
  rebuildsTables: boolean;
}

const MIGRATIONS: Migration[] = [
  { sql: SCHEMA, rebuildsTables: false },
  { sql: GOOGLE_AUTH_AND_BRANCHES, rebuildsTables: true },
  { sql: FORCED_REQUESTS, rebuildsTables: false },
  { sql: FAVORITE_APPS, rebuildsTables: false },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Applies the migrations newer than PRAGMA user_version, each in its own
 * transaction. A migration that rebuilds a table turns foreign keys off around
 * the transaction (the pragma is ignored inside one) and checks them before
 * committing, so the rebuild never leaves dangling references.
 */
function migrate(db: Db): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    if (m.rebuildsTables) db.exec('PRAGMA foreign_keys = OFF;');
    try {
      tx(db, () => {
        db.exec(m.sql);
        if (m.rebuildsTables && db.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error(`Migration ${i + 1} broke foreign keys`);
        }
        db.exec(`PRAGMA user_version = ${i + 1};`);
      });
    } finally {
      if (m.rebuildsTables) db.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
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
