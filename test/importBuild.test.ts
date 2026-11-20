import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { getRequest, importBuild, latestBuild, maxVersionCode, upsertApp } from '../src/store.ts';
import { JEEP_OBD2 } from '../src/apps.ts';
import { storeApk } from '../src/worker/pipeline.ts';
import { testSetup } from './helpers.ts';

test('an imported build is published as the latest APK with a finished request', () => {
  const s = testSetup();
  upsertApp(s.db, JEEP_OBD2);
  const source = path.join(s.dir, 'app-release.apk');
  fs.writeFileSync(source, 'apk-bytes');

  const apkFile = storeApk(s.config.apksDir, 'jeep-obd2', source, 1, 'e8a28b3abcdef');
  const build = importBuild(s.db, { appSlug: 'jeep-obd2', branch: 'main', versionCode: 1, apkFile, commitSha: 'e8a28b3abcdef' });

  assert.equal(apkFile, 'jeep-obd2-v1-e8a28b3.apk');
  assert.equal(fs.readFileSync(path.join(s.config.apksDir, 'jeep-obd2', apkFile), 'utf8'), 'apk-bytes');
  assert.deepEqual(latestBuild(s.db, 'jeep-obd2'), build);
  assert.equal(maxVersionCode(s.db, 'jeep-obd2'), 1);
  const req = getRequest(s.db, build.requestId);
  assert.equal(req?.status, 'built');
  assert.equal(req?.appSlug, 'jeep-obd2');
});
