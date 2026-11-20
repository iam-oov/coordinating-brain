import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createSession, getSession } from '../src/auth.ts';
import { SCHEMA, SCHEMA_VERSION, openDb } from '../src/db.ts';
import { latestBuild, listUsers } from '../src/store.ts';
import { tempDir } from './helpers.ts';

/** A database as production had it before migrations existed (user_version 0). */
function legacyDb(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO apps (slug, name, repo_url, allowed_paths, test_cmd, build_cmd, apk_path, created_at)
      VALUES ('jeep-obd2', 'Jeep OBD2', 'git@x:y.git', '["lib/"]', 't', 'b', 'a.apk', 0);
    INSERT INTO users (id, name, code_salt, code_hash, created_at) VALUES (1, 'osvaldo', 's', 'h', 0);
    INSERT INTO user_apps (user_id, app_slug) VALUES (1, 'jeep-obd2');
    INSERT INTO sessions (token_hash, user_id, is_admin, expires_at) VALUES ('admin-session', NULL, 1, 9999999999999);
    INSERT INTO requests (id, app_slug, user_id, text, status, created_at) VALUES (1, 'jeep-obd2', NULL, 'import', 'built', 0);
    INSERT INTO requests (id, app_slug, user_id, text, status, created_at) VALUES (2, 'jeep-obd2', 1, 'cambio', 'built', 0);
    INSERT INTO builds (request_id, app_slug, version_code, apk_file, commit_sha, created_at)
      VALUES (1, 'jeep-obd2', 1, 'v1.apk', 'e8a28b3', 1), (2, 'jeep-obd2', 2, 'v2.apk', '03f04a7', 2);
  `);
  db.close();
}

test('a pre-migration database keeps its users, sessions and builds', () => {
  const file = path.join(tempDir(), 'brain.db');
  legacyDb(file);
  const legacy = new DatabaseSync(file);
  const token = 'user-token';
  legacy
    .prepare('INSERT INTO sessions (token_hash, user_id, is_admin, expires_at) VALUES (?, 1, 0, 9999999999999)')
    .run(createHash('sha256').update(token).digest('hex'));
  legacy.close();

  const db = openDb(file);
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.deepEqual(listUsers(db), [{ id: 1, name: 'osvaldo', email: null, enabled: true, apps: ['jeep-obd2'] }]);
  assert.deepEqual(getSession(db, token), { userId: 1, isAdmin: false });
  assert.deepEqual({ ...db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id IS NULL').get() }, { n: 0 });
  assert.equal(latestBuild(db, 'jeep-obd2')?.versionCode, 2);
  assert.deepEqual(db.prepare('SELECT DISTINCT branch FROM builds').all().map((r) => ({ ...r })), [{ branch: 'main' }]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();

  const reopened = openDb(file);
  assert.equal(listUsers(reopened).length, 1);
  reopened.close();
});

test('a fresh database ends with the same schema as a migrated one', () => {
  const dir = tempDir();
  const migratedFile = path.join(dir, 'migrated.db');
  legacyDb(migratedFile);
  const schema = (db: DatabaseSync) =>
    (db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as {
      type: string;
      name: string;
    }[]).map((r) => `${r.type}:${r.name}`);
  const migrated = openDb(migratedFile);
  const fresh = openDb(path.join(dir, 'fresh.db'));
  assert.deepEqual(schema(fresh), schema(migrated));
  const columns = (db: DatabaseSync, table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name).sort();
  for (const t of ['users', 'requests', 'builds', 'apps', 'oauth_states']) assert.deepEqual(columns(fresh, t), columns(migrated, t));
  assert.ok(!columns(fresh, 'users').includes('code_hash'));
});

test('user ids are never reused after a delete', () => {
  const db = openDb(path.join(tempDir(), 'brain.db'));
  const add = (name: string) => Number(db.prepare('INSERT INTO users (name, created_at) VALUES (?, 0)').run(name).lastInsertRowid);
  add('a');
  const b = add('b');
  db.prepare('DELETE FROM users WHERE id = ?').run(b);
  assert.notEqual(add('c'), b);
});

test('a new session needs a real user', () => {
  const db = openDb(path.join(tempDir(), 'brain.db'));
  const uid = Number(db.prepare("INSERT INTO users (name, created_at) VALUES ('a', 0)").run().lastInsertRowid);
  const token = createSession(db, uid, true, 1);
  assert.deepEqual(getSession(db, token), { userId: uid, isAdmin: true });
  db.prepare('UPDATE users SET enabled = 0').run();
  assert.equal(getSession(db, token), null);
});

