/**
 * Admin CLI. Run on the server, next to the database:
 *
 *   npm run cli -- app:jeep                       register jeep-obd2 with its defaults
 *   npm run cli -- user:link osvaldo me@gmail.com link an existing user to the Google account with that email
 *   npm run cli -- user:grant osvaldo app1,app2
 *   npm run cli -- user:revoke osvaldo app1
 *   npm run cli -- user:disable osvaldo | user:enable osvaldo
 *   npm run cli -- user:list
 *   npm run cli -- app:list
 *   npm run cli -- build:import jeep-obd2 app.apk 1 e8a28b3   publish an APK built outside the worker
 */
import fs from 'node:fs';

import { JEEP_OBD2 } from './apps.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import {
  getApp,
  grantApps,
  importBuild,
  linkUserEmail,
  listApps,
  listUsers,
  maxVersionCode,
  revokeApps,
  setUserEnabled,
  upsertApp,
  userId,
} from './store.ts';
import { storeApk } from './worker/pipeline.ts';

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
const db = openDb(config.dbPath);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function need(value: string | undefined, what: string): string {
  if (!value) {
    console.error(`Missing ${what}.`);
    process.exit(2);
  }
  return value;
}

switch (command) {
  case 'app:jeep':
    upsertApp(db, JEEP_OBD2);
    console.log(`App ${JEEP_OBD2.slug} registered.`);
    break;
  case 'app:list':
    for (const a of listApps(db)) console.log(`${a.slug}\t${a.name}\t${a.repoUrl}\t${a.allowedPaths.join(',')}`);
    break;
  case 'user:link':
    linkUserEmail(db, need(args[0], 'user name'), need(args[1], 'email'));
    console.log('Done.');
    break;
  case 'user:grant':
    grantApps(db, userId(db, need(args[0], 'user name')), list(need(args[1], 'app slugs')));
    console.log('Done.');
    break;
  case 'user:revoke':
    revokeApps(db, userId(db, need(args[0], 'user name')), list(need(args[1], 'app slugs')));
    console.log('Done.');
    break;
  case 'user:disable':
  case 'user:enable':
    setUserEnabled(db, need(args[0], 'user name'), command === 'user:enable');
    console.log('Done.');
    break;
  case 'user:list':
    for (const u of listUsers(db)) {
      console.log(`${u.id}\t${u.name}\t${u.email ?? '-'}\t${u.enabled ? 'enabled' : 'disabled'}\t${u.apps.join(',')}`);
    }
    break;
  case 'build:import': {
    const slug = need(args[0], 'app slug');
    const apk = need(args[1], 'APK path');
    const versionCode = Number(need(args[2], 'version code'));
    const sha = need(args[3], 'commit SHA');
    if (!getApp(db, slug)) fail(`Unknown app ${slug}.`);
    if (!fs.existsSync(apk)) fail(`APK not found: ${apk}`);
    if (!Number.isInteger(versionCode) || versionCode <= maxVersionCode(db, slug)) {
      fail(`Version code must be an integer above ${maxVersionCode(db, slug)}.`);
    }
    if (!/^[0-9a-f]{7,40}$/.test(sha)) fail('Commit SHA must be 7-40 hex characters.');
    const apkFile = storeApk(config.apksDir, slug, apk, versionCode, sha);
    importBuild(db, { appSlug: slug, versionCode, apkFile, commitSha: sha });
    console.log(`Build ${apkFile} imported for ${slug}.`);
    break;
  }
  default:
    console.error(
      'Commands: app:jeep, app:list, user:link, user:grant, user:revoke, user:enable, user:disable, user:list, build:import',
    );
    process.exit(2);
}
db.close();
