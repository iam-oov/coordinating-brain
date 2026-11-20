import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Db } from '../src/db.ts';
import {
  claimNextApproved,
  createRequest,
  createRevertRequest,
  decideRequest,
  getRequest,
  importBuild,
  latestBuild,
  latestBuildFor,
  latestBuildOn,
} from '../src/store.ts';
import type { App, Request } from '../src/store.ts';
import { processRequest } from '../src/worker/pipeline.ts';
import type { AgentRunner, ImplementInput, ImplementOutput } from '../src/worker/runner.ts';
import { ADMIN_EMAIL, createTestUser, makeRemoteApp, pushToRemote, registerApp, remoteBranches, remoteState, sh, testSetup } from './helpers.ts';

/** Stands in for Claude: each attempt runs the next scripted step. */
class FakeRunner implements AgentRunner {
  readonly steps: ((input: ImplementInput) => ImplementOutput)[];
  readonly calls: ImplementInput[] = [];
  constructor(steps: ((input: ImplementInput) => ImplementOutput)[]) {
    this.steps = steps;
  }
  async implement(input: ImplementInput): Promise<ImplementOutput> {
    this.calls.push(input);
    const step = this.steps[Math.min(this.calls.length - 1, this.steps.length - 1)];
    return step(input);
  }
}

const write = (cwd: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
};

function setup(text = 'Agregar una pantalla de bienvenida al iniciar', email = 'osvaldo@example.test', alsoMain = false) {
  const { config, db } = testSetup();
  const { remote, app } = makeRemoteApp();
  registerApp(db, app);
  createTestUser(db, 'osvaldo', email, [app.slug]);
  return { config, db, remote, app, req: approve(db, app.slug, text, alsoMain) };
}

function approve(db: Db, slug: string, text: string, alsoMain = false, uid = 1): Request {
  const created = createRequest(db, uid, slug, text);
  assert.ok(created.ok);
  decideRequest(db, created.request.id, { approve: true, alsoMain });
  return claimNextApproved(db)!;
}

const writes = (files: Record<string, string>, summary = 'ok') => ({ cwd }: ImplementInput): ImplementOutput => {
  for (const [file, content] of Object.entries(files)) write(cwd, file, content);
  return { summary };
};

async function run(s: ReturnType<typeof setup>, runner: AgentRunner, req: Request = s.req) {
  await processRequest({ db: s.db, config: s.config, runner }, req);
  return getRequest(s.db, req.id)!;
}

test('happy path: lands on the author branch, main untouched, APK published under the branch', async () => {
  const s = setup();
  const mainBefore = remoteState(s.remote).log;
  const runner = new FakeRunner([writes({ 'lib/welcome.dart': 'String welcome() => "Bienvenido";\n' }, 'Agregué la pantalla de bienvenida.')]);
  const r = await run(s, runner);
  assert.equal(r.status, 'built', r.log);
  assert.equal(r.reason, 'Agregué la pantalla de bienvenida.');
  assert.equal(r.branch, 'users/1');

  assert.deepEqual(remoteState(s.remote).log, mainBefore);
  const state = remoteState(s.remote, 'users/1');
  assert.match(state.subject, /^feat\(brain\): Agregar una pantalla de bienvenida/);
  assert.ok(state.files.includes('lib/welcome.dart'));
  // Only the version line changes; the blank line and the rest are kept.
  assert.equal(state.pubspec, 'name: demo\nversion: 1.0.0+2\n\nenvironment:\n  sdk: ^3.0.0\n');
  assert.equal(r.branchSha, sh(s.remote, 'git', 'rev-parse', 'users/1'));

  const b = latestBuildOn(s.db, s.app.slug, 'users/1')!;
  assert.equal(b.versionCode, 2);
  assert.equal(b.apkFile, `users/1/demo-v2-${r.branchSha!.slice(0, 7)}.apk`);
  assert.ok(fs.existsSync(path.join(s.config.apksDir, s.app.slug, b.apkFile)));
  assert.equal(latestBuildOn(s.db, s.app.slug, 'main'), null);
  assert.equal(fs.readdirSync(s.config.workDir).length, 0);
  assert.equal(runner.calls[0].request.text, 'Agregar una pantalla de bienvenida al iniciar');
  // The public commit names the request, never its author.
  assert.doesNotMatch(sh(s.remote, 'git', 'log', '-1', '--format=%B', 'users/1'), /osvaldo/);
});

test('the AI refuses: discarded, nothing pushed', async () => {
  const s = setup();
  const before = remoteState(s.remote).log.length;
  const r = await run(s, new FakeRunner([() => ({ refused: 'No tiene relación con la app.', summary: '' })]));
  assert.equal(r.status, 'discarded');
  assert.match(r.reason ?? '', /No tiene relación/);
  assert.equal(remoteState(s.remote).log.length, before);
  assert.equal(latestBuild(s.db, s.app.slug), null);
});

test('gate violations are undone and retried; if they persist, nothing is pushed', async () => {
  const s = setup();
  const runner = new FakeRunner([
    ({ cwd }) => {
      write(cwd, 'android/app/build.gradle.kts', 'evil');
      return { summary: 'x' };
    },
  ]);
  const r = await run(s, runner);
  assert.equal(r.status, 'failed');
  assert.equal(runner.calls.length, 3);
  assert.match(runner.calls[1].feedback ?? '', /archivo protegido/);
  assert.ok(!remoteState(s.remote).files.includes('android/app/build.gradle.kts'));
});

test('failing tests are fed back to the AI, which fixes them on the next attempt', async () => {
  const s = setup();
  const runner = new FakeRunner([
    ({ cwd }) => {
      write(cwd, 'lib/feature.dart', '// BROKEN\n');
      return { summary: 'primer intento' };
    },
    ({ cwd }) => {
      write(cwd, 'lib/feature.dart', '// fixed\n');
      return { summary: 'Corregido.' };
    },
  ]);
  const r = await run(s, runner);
  assert.equal(r.status, 'built', r.log);
  assert.equal(runner.calls.length, 2);
  assert.match(runner.calls[1].feedback ?? '', /Pruebas failed/);
  assert.match(r.log, /Pruebas fallaron/);
});

test('no file changed on every attempt: failed', async () => {
  const s = setup();
  const runner = new FakeRunner([() => ({ summary: 'nada' })]);
  const r = await run(s, runner);
  assert.equal(r.status, 'failed');
  assert.match(runner.calls[1].feedback ?? '', /did not change any file/);
});

test('if the branch moved meanwhile, the local commit is rebased and verified before pushing', async () => {
  const s = setup();
  pushToRemote(s.remote, 'users/1', { 'lib/old.dart': '// old\n' }, 'earlier change');
  const runner = new FakeRunner([
    ({ cwd }) => {
      pushToRemote(s.remote, 'users/1', {}, 'parallel change');
      write(cwd, 'lib/welcome.dart', 'String w() => "hola";\n');
      return { summary: 'ok' };
    },
  ]);
  const r = await run(s, runner);
  assert.equal(r.status, 'built', r.log);
  assert.match(r.log, /rebase del commit local/);
  const log = remoteState(s.remote, 'users/1').log;
  assert.match(log[0], /^feat\(brain\)/);
  assert.equal(log[1], 'parallel change');
});

test('revert: the admin undoes a change on its branch with a new commit and a new APK', async () => {
  const s = setup();
  await run(s, new FakeRunner([writes({ 'lib/welcome.dart': 'String w() => "hola";\n' })]));
  const first = latestBuildOn(s.db, s.app.slug, 'users/1')!;
  const revert = createRevertRequest(s.db, first);
  const claimed = claimNextApproved(s.db)!;
  assert.equal(claimed.id, revert.id);
  assert.equal(claimed.branch, 'users/1');
  const mainBefore = remoteState(s.remote).log;
  const r = await run(s, new FakeRunner([]), claimed);
  assert.equal(r.status, 'built', r.log);

  const state = remoteState(s.remote, 'users/1');
  assert.match(state.subject, /^revert: Revertir build v2/);
  assert.ok(!state.files.includes('lib/welcome.dart'));
  assert.match(state.pubspec, /version: 1\.0\.0\+3/);
  assert.equal(latestBuildOn(s.db, s.app.slug, 'users/1')!.versionCode, 3);
  assert.ok(state.log.some((l) => l.startsWith('feat(brain)')));
  assert.deepEqual(remoteState(s.remote).log, mainBefore);
});

test('a crash inside the runner fails the request without publishing', async () => {
  const s = setup();
  const runner: AgentRunner = {
    implement: async () => {
      throw new Error('Claude Code falló (error_max_budget_usd)');
    },
  };
  const r = await run(s, runner);
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /error_max_budget_usd/);
  assert.equal(latestBuild(s.db, s.app.slug), null);
});

test('the build must produce the APK file', async () => {
  const s = setup();
  const app: App = { ...s.app, buildCmd: 'true' };
  registerApp(s.db, app);
  const r = await run(
    s,
    new FakeRunner([
      ({ cwd }) => {
        write(cwd, 'lib/x.dart', '// x\n');
        return { summary: 'ok' };
      },
    ]),
  );
  assert.equal(r.status, 'failed');
});

test('the protected core cannot be changed: undone, fed back, nothing pushed', async () => {
  const s = setup('Quitar el inicio de sesión con Google de la app');
  const runner = new FakeRunner([writes({ 'lib/core/auth.dart': 'const signIn = false;\n' })]);
  const r = await run(s, runner);
  assert.equal(r.status, 'failed');
  assert.match(runner.calls[1].feedback ?? '', /lib\/core\/auth\.dart: núcleo protegido/);
  assert.deepEqual(remoteBranches(s.remote), ['main']);
});

test('an existing branch gets the core and build files from main, keeps its features and version', async () => {
  const s = setup();
  pushToRemote(s.remote, 'users/1', {
    'lib/mine.dart': '// my feature\n',
    'lib/core/auth.dart': 'const signIn = false;\n',
    'pubspec.yaml': 'name: demo\nversion: 1.0.0+7\n\nenvironment:\n  sdk: ^3.0.0\n',
  });
  pushToRemote(s.remote, 'main', {
    'lib/core/auth.dart': 'const signIn = 2;\n',
    'android/build.gradle': 'new\n',
    'lib/main_only.dart': '// a main feature\n',
    'pubspec.yaml': 'name: demo\nversion: 1.0.0+3\n\nenvironment:\n  sdk: ^3.1.0\n',
  });
  const r = await run(s, new FakeRunner([writes({ 'lib/welcome.dart': '// hola\n' })]));
  assert.equal(r.status, 'built', r.log);

  const state = remoteState(s.remote, 'users/1');
  assert.equal(state.read('lib/core/auth.dart'), 'const signIn = 2;\n');
  assert.equal(state.read('android/build.gradle'), 'new\n');
  assert.ok(state.files.includes('lib/mine.dart'));
  assert.ok(!state.files.includes('lib/main_only.dart'));
  assert.equal(state.pubspec, 'name: demo\nversion: 1.0.0+8\n\nenvironment:\n  sdk: ^3.1.0\n');
  assert.match(state.log[1], /^chore\(core\): sync from main [0-9a-f]{7}$/);
});

test('also main (admin): main first, then carried to the admin branch, two APKs with growing versions', async () => {
  const s = setup('Agregar un botón para compartir el código', ADMIN_EMAIL, true);
  pushToRemote(s.remote, 'users/1', { 'lib/mine.dart': '// mine\n', 'pubspec.yaml': 'name: demo\nversion: 1.0.0+5\n\nenvironment:\n  sdk: ^3.0.0\n' });
  const r = await run(s, new FakeRunner([writes({ 'lib/share.dart': '// share\n' })]));
  assert.equal(r.status, 'built', r.log);

  const main = remoteState(s.remote);
  const mine = remoteState(s.remote, 'users/1');
  assert.ok(main.files.includes('lib/share.dart'));
  assert.ok(!main.files.includes('lib/mine.dart'));
  assert.ok(mine.files.includes('lib/share.dart') && mine.files.includes('lib/mine.dart'));
  assert.equal(r.mainSha, sh(s.remote, 'git', 'rev-parse', 'main'));
  assert.equal(r.branchSha, sh(s.remote, 'git', 'rev-parse', 'users/1'));
  assert.equal(latestBuildOn(s.db, s.app.slug, 'main')!.versionCode, 2);
  assert.equal(latestBuildOn(s.db, s.app.slug, 'users/1')!.versionCode, 6);
});

test('also main (admin) without a branch yet: the branch starts at main and uses its APK', async () => {
  const s = setup('Agregar un botón para compartir el código', ADMIN_EMAIL, true);
  const r = await run(s, new FakeRunner([writes({ 'lib/share.dart': '// share\n' })]));
  assert.equal(r.status, 'built', r.log);
  assert.equal(sh(s.remote, 'git', 'rev-parse', 'users/1'), sh(s.remote, 'git', 'rev-parse', 'main'));
  assert.equal(latestBuildOn(s.db, s.app.slug, 'users/1'), null);
  assert.equal(latestBuildFor(s.db, s.app, 1)!.branch, 'main');
});

test('also main forced on a non-admin request: fails before the AI runs, main untouched', async () => {
  const s = setup();
  s.db.prepare('UPDATE requests SET also_main = 1 WHERE id = ?').run(s.req.id);
  const runner = new FakeRunner([writes({ 'lib/x.dart': '// x\n' })]);
  const r = await run(s, runner, getRequest(s.db, s.req.id)!);
  assert.equal(r.status, 'failed');
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(remoteBranches(s.remote), ['main']);
});

test('a request picked up again after a restart republishes without calling the AI', async () => {
  const s = setup();
  await run(s, new FakeRunner([writes({ 'lib/welcome.dart': '// hola\n' })]));
  s.db.prepare('DELETE FROM builds').run();
  s.db.prepare(`UPDATE requests SET status = 'running' WHERE id = ?`).run(s.req.id);
  const runner = new FakeRunner([]);
  const r = await run(s, runner, getRequest(s.db, s.req.id)!);
  assert.equal(r.status, 'built', r.log);
  assert.equal(runner.calls.length, 0);
  assert.equal(latestBuildOn(s.db, s.app.slug, 'users/1')!.commitSha, r.branchSha);
});

test('each user gets their own build, or main\'s; never another user\'s', async () => {
  const s = setup();
  createTestUser(s.db, 'ana', 'ana@example.test', [s.app.slug]);
  importBuild(s.db, { appSlug: s.app.slug, branch: 'main', versionCode: 1, apkFile: 'demo-v1.apk', commitSha: 'aaaaaaa' });
  await run(s, new FakeRunner([writes({ 'lib/welcome.dart': '// hola\n' })]));
  assert.equal(latestBuildFor(s.db, s.app, 1)!.branch, 'users/1');
  assert.equal(latestBuildFor(s.db, s.app, 2)!.branch, 'main');
  assert.equal(latestBuild(s.db, s.app.slug)!.branch, 'users/1');
});
