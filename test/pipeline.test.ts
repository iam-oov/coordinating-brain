import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  createRequest,
  createRevertRequest,
  decideRequest,
  getRequest,
  latestBuild,
  claimNextApproved,
} from '../src/store.ts';
import type { App, Request } from '../src/store.ts';
import { processRequest } from '../src/worker/pipeline.ts';
import type { AgentRunner, ImplementInput, ImplementOutput } from '../src/worker/runner.ts';
import { createTestUser, makeRemoteApp, registerApp, remoteState, sh, tempDir, testSetup } from './helpers.ts';

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

function setup(text = 'Agregar una pantalla de bienvenida al iniciar') {
  const { config, db } = testSetup();
  const { remote, app } = makeRemoteApp();
  registerApp(db, app);
  createTestUser(db, 'osvaldo', 'osvaldo@example.test', [app.slug]);
  const created = createRequest(db, 1, app.slug, text);
  assert.ok(created.ok);
  decideRequest(db, created.request.id, true, null);
  const req = claimNextApproved(db)!;
  return { config, db, remote, app, req };
}

async function run(s: ReturnType<typeof setup>, runner: AgentRunner, req: Request = s.req) {
  await processRequest({ db: s.db, config: s.config, runner }, req);
  return getRequest(s.db, req.id)!;
}

test('happy path: gate, tests, build, push to main, APK published, version bumped', async () => {
  const s = setup();
  const runner = new FakeRunner([
    ({ cwd }) => {
      write(cwd, 'lib/welcome.dart', 'String welcome() => "Bienvenido";\n');
      return { summary: 'Agregué la pantalla de bienvenida.' };
    },
  ]);
  const r = await run(s, runner);
  assert.equal(r.status, 'built', r.log);
  assert.equal(r.reason, 'Agregué la pantalla de bienvenida.');

  const state = remoteState(s.remote);
  assert.match(state.subject, /^feat\(brain\): Agregar una pantalla de bienvenida/);
  assert.ok(state.files.includes('lib/welcome.dart'));
  assert.match(state.pubspec, /version: 1\.0\.0\+2/);
  // Only the version line changes; the blank line and the rest are kept.
  assert.equal(state.pubspec, 'name: demo\nversion: 1.0.0+2\n\nenvironment:\n  sdk: ^3.0.0\n');

  const b = latestBuild(s.db, s.app.slug)!;
  assert.equal(b.versionCode, 2);
  assert.ok(fs.existsSync(path.join(s.config.apksDir, s.app.slug, b.apkFile)));
  // The work directory is cleaned up.
  assert.equal(fs.readdirSync(s.config.workDir).length, 0);
  // The request text reaches the AI fenced as data, never as the system prompt.
  assert.equal(runner.calls[0].request.text, 'Agregar una pantalla de bienvenida al iniciar');
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

test('if main moved meanwhile, the local commit is rebased and verified before pushing', async () => {
  const s = setup();
  const runner = new FakeRunner([
    ({ cwd }) => {
      // Someone else pushes to main while the AI works.
      const other = path.join(tempDir('brain-other-'), 'o');
      sh(path.dirname(other), 'git', 'clone', '-q', s.remote, other);
      sh(other, 'git', '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'parallel change');
      sh(other, 'git', 'push', '-q', 'origin', 'main');
      write(cwd, 'lib/welcome.dart', 'String w() => "hola";\n');
      return { summary: 'ok' };
    },
  ]);
  const r = await run(s, runner);
  assert.equal(r.status, 'built', r.log);
  assert.match(r.log, /rebase del commit local/);
  const log = remoteState(s.remote).log;
  assert.match(log[0], /^feat\(brain\)/);
  assert.equal(log[1], 'parallel change');
});

test('revert: the admin undoes a published change with a new commit and a new APK', async () => {
  const s = setup();
  await run(
    s,
    new FakeRunner([
      ({ cwd }) => {
        write(cwd, 'lib/welcome.dart', 'String w() => "hola";\n');
        return { summary: 'ok' };
      },
    ]),
  );
  const first = latestBuild(s.db, s.app.slug)!;
  const revert = createRevertRequest(s.db, first);
  const claimed = claimNextApproved(s.db)!;
  assert.equal(claimed.id, revert.id);
  const r = await run(s, new FakeRunner([]), claimed);
  assert.equal(r.status, 'built', r.log);

  const state = remoteState(s.remote);
  assert.match(state.subject, /^revert: Revertir build v2/);
  assert.ok(!state.files.includes('lib/welcome.dart'));
  assert.match(state.pubspec, /version: 1\.0\.0\+3/);
  assert.equal(latestBuild(s.db, s.app.slug)!.versionCode, 3);
  // History is never rewritten: both commits are there.
  assert.ok(state.log.some((l) => l.startsWith('feat(brain)')));
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
