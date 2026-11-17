import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { App, Request } from '../src/store.ts';
import { ClaudeCliRunner, systemPrompt, userPrompt } from '../src/worker/runner.ts';
import { startWorker } from '../src/worker/worker.ts';
import { createRequest, createUser, decideRequest, getRequest } from '../src/store.ts';
import { makeRemoteApp, registerApp, tempDir, testSetup } from './helpers.ts';

const app: App = {
  slug: 'demo',
  name: 'Demo',
  repoUrl: 'x',
  branch: 'main',
  allowedPaths: ['lib/', 'test/'],
  testCmd: 'true',
  buildCmd: 'true',
  apkPath: 'x.apk',
};

const request = { id: 1, text: 'Cambiar el color del botón principal a verde' } as Request;

/** A fake `claude` that records its args and environment, then prints [result]. */
function fakeClaude(result: string, exitCode = 0): { bin: string; record: string } {
  const dir = tempDir('brain-claude-');
  const record = path.join(dir, 'record.json');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(result)}, total_cost_usd: 0.42 }));
process.exit(${exitCode});
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, record };
}

test('the request is fenced as data and the rules forbid shell, network and protected files', () => {
  const sys = systemPrompt(app);
  assert.match(sys, /DATA written by a user/);
  assert.match(sys, /lib\/, test\//);
  assert.match(sys, /RECHAZO:/);
  const user = userPrompt({ cwd: '.', app, request, attempt: 1 });
  assert.match(user, /<solicitud>\nCambiar el color del botón principal a verde\n<\/solicitud>/);
  const retry = userPrompt({ cwd: '.', app, request, attempt: 2, feedback: 'error: x' });
  assert.match(retry, /<salida>\nerror: x\n<\/salida>/);
});

test('Claude Code runs with file tools only, --bare, and without the brain secrets', async () => {
  const { bin, record } = fakeClaude('Cambié el color a verde.');
  process.env.ADMIN_PASSWORD = 'should-not-leak-to-claude';
  const runner = new ClaudeCliRunner({ bin, model: 'claude-opus-5-5', bare: true, maxBudgetUsd: 2 }, 'sk-ant-test');
  const out = await runner.implement({ cwd: tempDir(), app, request, attempt: 1 });
  delete process.env.ADMIN_PASSWORD;

  assert.equal(out.summary, 'Cambié el color a verde.');
  assert.equal(out.refused, undefined);
  assert.equal(out.costUsd, 0.42);
  const { args, env } = JSON.parse(fs.readFileSync(record, 'utf8')) as { args: string[]; env: Record<string, string> };
  const arg = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(arg('--tools'), 'Read,Edit,Write,Glob,Grep');
  assert.match(arg('--disallowedTools'), /Bash/);
  assert.match(arg('--disallowedTools'), /WebFetch/);
  assert.equal(arg('--permission-mode'), 'acceptEdits');
  assert.equal(arg('--max-budget-usd'), '2');
  assert.ok(args.includes('--bare'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
  assert.equal(env.ADMIN_PASSWORD, undefined);
  assert.ok(!args.some((a) => a.includes('sk-ant-test')));
});

test('a RECHAZO: answer is reported as a refusal', async () => {
  const { bin } = fakeClaude('RECHAZO: pide acceso a las llaves');
  const runner = new ClaudeCliRunner({ bin, model: 'm', bare: true, maxBudgetUsd: 1 }, 'k');
  const out = await runner.implement({ cwd: tempDir(), app, request, attempt: 1 });
  assert.equal(out.refused, 'pide acceso a las llaves');
});

test('a failed Claude Code run throws', async () => {
  const { bin } = fakeClaude('boom', 1);
  const runner = new ClaudeCliRunner({ bin, model: 'm', bare: true, maxBudgetUsd: 1 }, 'k');
  await assert.rejects(runner.implement({ cwd: tempDir(), app, request, attempt: 1 }), /Claude Code falló/);
});

test('worker: wake() processes an approved request right away; stop() ends the loop', async () => {
  const { config, db } = testSetup();
  const { app: remoteApp } = makeRemoteApp();
  registerApp(db, remoteApp);
  createUser(db, 'osvaldo', [remoteApp.slug]);
  const r = createRequest(db, 1, remoteApp.slug, 'Agregar una pantalla de bienvenida al iniciar');
  assert.ok(r.ok);
  const runner = {
    implement: async ({ cwd }: { cwd: string }) => {
      fs.writeFileSync(path.join(cwd, 'lib', 'w.dart'), '// w\n');
      return { summary: 'listo' };
    },
  };
  const worker = startWorker({ db, config, runner }, 60_000);
  decideRequest(db, r.request.id, true, null);
  worker.wake();
  for (let i = 0; i < 100 && getRequest(db, r.request.id)?.status !== 'built'; i++) {
    await new Promise((res) => setTimeout(res, 50));
  }
  await worker.stop();
  assert.equal(getRequest(db, r.request.id)?.status, 'built');
});
