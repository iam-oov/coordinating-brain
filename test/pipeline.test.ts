import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Db } from '../src/db.ts';
import {
  buildForRequest,
  claimNextApproved,
  createRequest,
  createRevertRequest,
  decideRequest,
  decideReview,
  forceRequest,
  getRequest,
  importBuild,
  latestBuild,
  latestBuildFor,
  latestBuildOn,
  retryBranchCarry,
} from '../src/store.ts';
import type { App, Request } from '../src/store.ts';
import { processRequest, withoutInfoLines } from '../src/worker/pipeline.ts';
import { DirectSandbox } from '../src/worker/sandbox.ts';
import type { TestSandbox } from '../src/worker/sandbox.ts';
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

async function run(s: ReturnType<typeof setup>, runner: AgentRunner, req: Request = s.req, sandbox: TestSandbox = new DirectSandbox()) {
  await processRequest({ db: s.db, config: s.config, runner, sandbox }, req);
  return getRequest(s.db, req.id)!;
}

/** Fails the sandboxed tests whenever [branch] is checked out, like the stale build-hook artifacts did. */
class FailingOnBranch implements TestSandbox {
  readonly branch: string;
  constructor(branch: string) {
    this.branch = branch;
  }
  async run(cwd: string, command: string, timeoutMs: number) {
    if (sh(cwd, 'git', 'rev-parse', '--abbrev-ref', 'HEAD') === this.branch) {
      return { code: 1, output: 'stale build hooks', timedOut: false };
    }
    return new DirectSandbox().run(cwd, command, timeoutMs);
  }
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

test('also main (admin) without a branch yet: the branch starts at main with the same APK as its own', async () => {
  const s = setup('Agregar un botón para compartir el código', ADMIN_EMAIL, true);
  const r = await run(s, new FakeRunner([writes({ 'lib/share.dart': '// share\n' })]));
  assert.equal(r.status, 'built', r.log);
  assert.equal(sh(s.remote, 'git', 'rev-parse', 'users/1'), sh(s.remote, 'git', 'rev-parse', 'main'));
  const mainBuild = latestBuildOn(s.db, s.app.slug, 'main')!;
  const own = latestBuildFor(s.db, s.app, 1)!;
  assert.equal(own.branch, 'users/1');
  assert.equal(own.apkFile, mainBuild.apkFile);
  assert.equal(own.versionCode, mainBuild.versionCode);
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

test('each user gets only their own build: never main\'s, never another user\'s', async () => {
  const s = setup();
  createTestUser(s.db, 'ana', 'ana@example.test', [s.app.slug]);
  importBuild(s.db, { appSlug: s.app.slug, branch: 'main', versionCode: 1, apkFile: 'demo-v1.apk', commitSha: 'aaaaaaa' });
  await run(s, new FakeRunner([writes({ 'lib/welcome.dart': '// hola\n' })]));
  assert.equal(latestBuildFor(s.db, s.app, 1)!.branch, 'users/1');
  assert.equal(latestBuildFor(s.db, s.app, 2), null);
  assert.equal(latestBuild(s.db, s.app.slug)!.branch, 'users/1');
});

async function forcedToReview(s: ReturnType<typeof setup>) {
  await run(s, new FakeRunner([() => ({ refused: 'Toca el núcleo protegido.', summary: '' })]));
  assert.ok(forceRequest(s.db, s.req.id));
  const forced = claimNextApproved(s.db)!;
  const runner = new FakeRunner([
    writes(
      {
        'lib/core/mic.dart': '// mic in the core\n',
        'pubspec.yaml': 'name: demo\nversion: 1.0.0+1\n\nenvironment:\n  sdk: ^3.0.0\ndependencies:\n  speech_to_text: ^7.0.0\n',
      },
      'Agregué el micrófono al buzón.',
    ),
  ]);
  return { forced, runner, r: await run(s, runner, forced) };
}

test('forced: a discarded request is implemented with the core unlocked and stops for review, nothing pushed', async () => {
  const s = setup('Agregar un botón de micrófono en el buzón');
  const { runner, r } = await forcedToReview(s);
  assert.equal(r.status, 'review', r.log);
  assert.equal(runner.calls[0].request.forced, true);
  assert.match(r.reviewPatch ?? '', /lib\/core\/mic\.dart/);
  assert.match(r.reviewPatch ?? '', /speech_to_text/);
  assert.doesNotMatch(r.reviewPatch ?? '', /version: 1\.0\.0\+2/);
  assert.equal(r.reason, 'Agregué el micrófono al buzón.');
  assert.deepEqual(remoteBranches(s.remote), ['main']);
  assert.equal(latestBuild(s.db, s.app.slug), null);
});

test('forced: after the review it publishes the reviewed diff to main and the author branch without the AI', async () => {
  const s = setup('Agregar un botón de micrófono en el buzón');
  pushToRemote(s.remote, 'users/1', { 'lib/mine.dart': '// mine\n' });
  await forcedToReview(s);
  assert.ok(decideReview(s.db, s.req.id, true));
  const runner = new FakeRunner([]);
  const r = await run(s, runner, claimNextApproved(s.db)!);
  assert.equal(r.status, 'built', r.log);
  assert.equal(runner.calls.length, 0);

  const main = remoteState(s.remote);
  assert.equal(main.read('lib/core/mic.dart'), '// mic in the core\n');
  assert.match(main.pubspec, /speech_to_text/);
  assert.match(main.pubspec, /version: 1\.0\.0\+2/);
  const mine = remoteState(s.remote, 'users/1');
  assert.equal(mine.read('lib/core/mic.dart'), '// mic in the core\n');
  assert.match(mine.pubspec, /speech_to_text/);
  assert.ok(mine.files.includes('lib/mine.dart'));
  assert.equal(latestBuildOn(s.db, s.app.slug, 'main')!.versionCode, 2);
  assert.equal(latestBuildOn(s.db, s.app.slug, 'users/1')!.versionCode, 3);
});

test('forced: a change on main that never reached the author branch is retried there without the AI or a new main build', async () => {
  const s = setup('Agregar un botón de micrófono en el buzón');
  pushToRemote(s.remote, 'users/1', { 'lib/mine.dart': '// mine\n' });
  await forcedToReview(s);
  assert.ok(decideReview(s.db, s.req.id, true));
  const first = await run(s, new FakeRunner([]), claimNextApproved(s.db)!, new FailingOnBranch('users/1'));
  assert.equal(first.status, 'built', first.log);
  assert.match(first.log, /No llegó a users\/1/);
  assert.equal(first.branchSha, null);
  assert.equal(first.mainSha, sh(s.remote, 'git', 'rev-parse', 'main'));
  assert.equal(first.reason, 'Agregué el micrófono al buzón.');
  assert.ok(!remoteState(s.remote, 'users/1').files.includes('lib/core/mic.dart'));

  assert.ok(retryBranchCarry(s.db, s.req.id));
  const queued = getRequest(s.db, s.req.id)!;
  assert.equal(queued.status, 'approved');
  assert.equal(queued.startedAt, null);
  assert.equal(queued.finishedAt, null);
  assert.equal(queued.mainSha, first.mainSha);
  assert.equal(queued.reviewOk, true);
  assert.equal(retryBranchCarry(s.db, s.req.id), false);

  const runner = new FakeRunner([]);
  const r = await run(s, runner, claimNextApproved(s.db)!);
  assert.equal(r.status, 'built', r.log);
  assert.equal(runner.calls.length, 0);
  assert.equal(r.mainSha, first.mainSha);
  assert.equal(r.reason, 'Agregué el micrófono al buzón.');
  const mainBuilds = s.db.prepare(`SELECT COUNT(*) AS n FROM builds WHERE request_id = ? AND branch = 'main'`).get(s.req.id) as { n: number };
  assert.equal(mainBuilds.n, 1);

  const mine = remoteState(s.remote, 'users/1');
  assert.equal(mine.read('lib/core/mic.dart'), '// mic in the core\n');
  assert.ok(mine.files.includes('lib/mine.dart'));
  assert.equal(r.branchSha, sh(s.remote, 'git', 'rev-parse', 'users/1'));
  assert.equal(buildForRequest(s.db, s.req.id, 'users/1')!.commitSha, r.branchSha);
  // Once the branch has it, there is nothing left to retry.
  assert.equal(retryBranchCarry(s.db, s.req.id), false);
});

test('retryBranchCarry only matches built changes that reached main but not their own branch', async () => {
  const s = setup();
  const id = s.req.id;
  const reset = (sql: string) => s.db.prepare(`UPDATE requests SET status = 'built', kind = 'change', main_sha = 'abc', branch_sha = NULL, forced = 1, also_main = 0, branch = 'users/1', ${sql} WHERE id = ?`).run(id);
  const cases: [string, boolean][] = [
    ['reason = reason', true],
    ['forced = 0, also_main = 1', true],
    ['forced = 0, also_main = 0', false],
    [`status = 'failed'`, false],
    [`kind = 'revert'`, false],
    ['main_sha = NULL', false],
    [`branch_sha = 'def'`, false],
    [`branch = 'main'`, false],
  ];
  for (const [sql, expected] of cases) {
    reset(sql);
    assert.equal(retryBranchCarry(s.db, id), expected, sql);
  }
  assert.equal(retryBranchCarry(s.db, 9999), false);
});

test('forced: discarded at review never reaches the repo; a stale diff fails instead of guessing', async () => {
  const s = setup('Agregar un botón de micrófono en el buzón');
  await forcedToReview(s);
  assert.ok(decideReview(s.db, s.req.id, false));
  assert.equal(getRequest(s.db, s.req.id)?.status, 'discarded');
  assert.deepEqual(remoteBranches(s.remote), ['main']);

  assert.ok(forceRequest(s.db, s.req.id));
  await run(s, new FakeRunner([writes({ 'lib/core/auth.dart': 'const signIn = 3;\n' })]), claimNextApproved(s.db)!);
  pushToRemote(s.remote, 'main', { 'lib/core/auth.dart': 'const signIn = 4;\n' });
  assert.ok(decideReview(s.db, s.req.id, true));
  const r = await run(s, new FakeRunner([]), claimNextApproved(s.db)!);
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /ya no aplica/);
});

test('verification output drops analyzer info lines so the real errors reach the log and the AI', () => {
  const out = [
    '   info • deprecated import • test/a.dart:1:1 • deprecated_member_use',
    "  error • The method 'listen' isn't defined • lib/core/mic.dart:12:5 • undefined_method",
    '   info • deprecated import • test/b.dart:1:1 • deprecated_member_use',
    '3 issues found.',
  ].join('\n');
  const kept = withoutInfoLines(out);
  assert.match(kept, /error • The method 'listen'/);
  assert.doesNotMatch(kept, /deprecated_member_use/);
  assert.match(kept, /2 avisos "info" omitidos/);
  assert.equal(withoutInfoLines('All tests passed!'), 'All tests passed!');
});

test('forced: edits to pubspec.lock are dropped before the gate instead of failing the attempt', async () => {
  const s = setup('Agregar un botón de micrófono en el buzón');
  pushToRemote(s.remote, 'main', { 'pubspec.lock': 'packages: {}\n' });
  await run(s, new FakeRunner([() => ({ refused: 'Toca el núcleo.', summary: '' })]));
  assert.ok(forceRequest(s.db, s.req.id));
  const runner = new FakeRunner([
    writes({ 'lib/core/mic.dart': '// mic\n', 'pubspec.lock': `sha256: "${'ab'.repeat(40)}"\n` }),
  ]);
  const r = await run(s, runner, claimNextApproved(s.db)!);
  assert.equal(r.status, 'review', r.log);
  assert.equal(runner.calls.length, 1);
  assert.doesNotMatch(r.reviewPatch ?? '', /pubspec\.lock/);
});
