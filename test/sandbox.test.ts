import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { SystemdSandbox } from '../src/worker/sandbox.ts';
import { tempDir } from './helpers.ts';

/** Stands in for `systemctl start --wait cb-test@<id>.service`, like run-tests does. */
function fakeSystemctl(root: string): { bin: string; calls: string } {
  const dir = tempDir('brain-systemctl-');
  const bin = path.join(dir, 'systemctl');
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(calls)}
id="\${3#cb-test@}"; id="\${id%.service}"
[[ "$1 $2" == "start --wait" && "$id" =~ ^[0-9]+$ ]] || exit 9
cd ${JSON.stringify(root)}/"$id" && bash .cmd > .out 2>&1 || { echo "Job for $3 failed." >&2; exit 3; }
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, calls };
}

function workCopy(): string {
  const dir = tempDir('brain-work-');
  for (const [file, content] of Object.entries({
    'lib/main.dart': 'void main() {}\n',
    '.dart_tool/package_config.json': '{}\n',
    '.git/config': 'secret remote\n',
    'build/app.apk': 'apk\n',
    '.dart_tool/hooks_runner/shared/objective_c/.lock': '',
    '.dart_tool/flutter_build/abc/app.dill': 'dill\n',
  })) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

test('the sandbox runs the command on a copy without .git or build, then removes it', async () => {
  const root = tempDir('brain-sandbox-');
  const { bin, calls } = fakeSystemctl(root);
  const box = new SystemdSandbox(root, bin);
  const r = await box.run(workCopy(), 'ls -A lib .dart_tool; ls -A; echo TESTS_OK', 60_000);
  assert.doesNotMatch(r.output, /hooks_runner|flutter_build/);

  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /main\.dart/);
  assert.match(r.output, /package_config\.json/);
  assert.match(r.output, /TESTS_OK/);
  assert.doesNotMatch(r.output, /^\.git$|^build$/m);
  assert.match(fs.readFileSync(calls, 'utf8'), /^start --wait cb-test@\d+\.service$/m);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a failing command reports its output and the unit failure; every run gets a new directory', async () => {
  const root = tempDir('brain-sandbox-');
  const { bin, calls } = fakeSystemctl(root);
  const box = new SystemdSandbox(root, bin);
  const work = workCopy();
  const r = await box.run(work, 'echo "test failed: expected 2"; exit 1', 60_000);
  await box.run(work, 'true', 60_000);

  assert.notEqual(r.code, 0);
  assert.match(r.output, /test failed: expected 2/);
  assert.match(r.output, /failed/);
  const ids = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.equal(new Set(ids).size, 2);
  assert.ok(fs.existsSync(path.join(work, '.git', 'config')));
});

test('packages that pub extracted as owner-only become readable by the sandbox group before each run', async () => {
  const root = tempDir('brain-sandbox-');
  const cache = tempDir('brain-pubcache-');
  const pkg = path.join(cache, 'hosted', 'pub.dev', 'google_sign_in-7.2.0', 'lib');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'google_sign_in.dart'), '// lib\n');
  fs.chmodSync(path.join(pkg, 'google_sign_in.dart'), 0o600);
  for (const d of [pkg, path.dirname(pkg)]) fs.chmodSync(d, 0o700);
  const { bin } = fakeSystemctl(root);
  const box = new SystemdSandbox(root, bin, [cache]);
  const r = await box.run(workCopy(), 'true', 60_000);
  assert.equal(r.code, 0, r.output);
  assert.equal(fs.statSync(path.dirname(pkg)).mode & 0o050, 0o050);
  assert.equal(fs.statSync(path.join(pkg, 'google_sign_in.dart')).mode & 0o040, 0o040);
  assert.equal(fs.statSync(path.join(pkg, 'google_sign_in.dart')).mode & 0o010, 0);
});
