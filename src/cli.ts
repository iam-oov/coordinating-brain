/**
 * Admin CLI. Run on the server, next to the database:
 *
 *   npm run cli -- app:jeep                       register jeep-obd2 with its defaults
 *   npm run cli -- user:add osvaldo jeep-obd2     create a user; prints the 4-digit code once
 *   npm run cli -- user:grant osvaldo app1,app2
 *   npm run cli -- user:revoke osvaldo app1
 *   npm run cli -- user:reset-code osvaldo        prints a new code; old sessions are closed
 *   npm run cli -- user:disable osvaldo | user:enable osvaldo
 *   npm run cli -- user:list
 *   npm run cli -- app:list
 */
import { JEEP_OBD2 } from './apps.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import {
  createUser,
  grantApps,
  listApps,
  listUsers,
  resetUserCode,
  revokeApps,
  setUserEnabled,
  upsertApp,
  userId,
} from './store.ts';

const [command, ...args] = process.argv.slice(2);
const db = openDb(loadConfig().dbPath);
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
  case 'user:add': {
    const code = createUser(db, need(args[0], 'user name'), list(args[1]));
    console.log(`User ${args[0]} created. Code (shown only now): ${code}`);
    break;
  }
  case 'user:grant':
    grantApps(db, userId(db, need(args[0], 'user name')), list(need(args[1], 'app slugs')));
    console.log('Done.');
    break;
  case 'user:revoke':
    revokeApps(db, userId(db, need(args[0], 'user name')), list(need(args[1], 'app slugs')));
    console.log('Done.');
    break;
  case 'user:reset-code':
    console.log(`New code for ${args[0]} (shown only now): ${resetUserCode(db, need(args[0], 'user name'))}`);
    break;
  case 'user:disable':
  case 'user:enable':
    setUserEnabled(db, need(args[0], 'user name'), command === 'user:enable');
    console.log('Done.');
    break;
  case 'user:list':
    for (const u of listUsers(db)) console.log(`${u.name}\t${u.enabled ? 'enabled' : 'disabled'}\t${u.apps.join(',')}`);
    break;
  default:
    console.error('Commands: app:jeep, app:list, user:add, user:grant, user:revoke, user:reset-code, user:enable, user:disable, user:list');
    process.exit(2);
}
db.close();
