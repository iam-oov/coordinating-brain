import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import type { App, Request } from '../store.ts';
import { addBuild, appendLog, finishRequest, getApp, maxVersionCode } from '../store.ts';
import { checkDiff } from './diffGate.ts';
import { git, run, runShell, tail } from './exec.ts';
import type { AgentRunner } from './runner.ts';

export const MAX_ATTEMPTS = 3;
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

export interface PipelineDeps {
  db: Db;
  config: Config;
  runner: AgentRunner;
}

/** Thrown to end a request with a given final status and a reason for the user. */
class Stop extends Error {
  readonly status: 'failed' | 'discarded';
  constructor(status: 'failed' | 'discarded', reason: string) {
    super(reason);
    this.status = status;
  }
}

/**
 * Runs one approved request end to end. Nothing reaches the app's main branch
 * unless the change passed the diff gate, the tests and the build. The APK is
 * published only after the push, so the latest APK always matches main.
 */
export async function processRequest(deps: PipelineDeps, req: Request): Promise<void> {
  const { db, config } = deps;
  const log = (line: string) => appendLog(db, req.id, line);
  const app = getApp(db, req.appSlug);
  const dir = path.join(config.workDir, `${req.appSlug}-${req.id}`);

  try {
    if (!app) throw new Stop('failed', `La app ${req.appSlug} ya no existe.`);
    fs.mkdirSync(config.workDir, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    log(`Clonando ${app.repoUrl} (${app.branch})`);
    await git(config.workDir, 'clone', '--branch', app.branch, '--single-branch', app.repoUrl, dir);
    await git(dir, 'config', 'user.name', config.gitAuthorName);
    await git(dir, 'config', 'user.email', config.gitAuthorEmail);

    const summary =
      req.kind === 'revert' ? await prepareRevert(dir, req, log) : await implementWithRetries(deps, app, req, dir, log);

    const versionCode = await commitAndPush(deps, app, req, dir, summary, log);
    const sha = await git(dir, 'rev-parse', 'HEAD');
    const apkFile = publishApk(config, app, dir, versionCode, sha);
    addBuild(db, { requestId: req.id, appSlug: app.slug, versionCode, apkFile, commitSha: sha });
    log(`APK publicado: ${apkFile}`);
    finishRequest(db, req.id, 'built', summary);
  } catch (e) {
    const stop = e instanceof Stop ? e : null;
    const reason = stop ? stop.message : `Error inesperado: ${(e as Error).message}`;
    log(`Terminado sin publicar: ${reason}`);
    finishRequest(db, req.id, stop?.status ?? 'failed', reason.slice(0, 1000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** AI attempts until the change passes the gate, analyzer, tests and build. */
async function implementWithRetries(
  deps: PipelineDeps,
  app: App,
  req: Request,
  dir: string,
  log: (l: string) => void,
): Promise<string> {
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Drop the version bump of a previous attempt so the gate only sees the AI's edits.
    if (fs.existsSync(path.join(dir, 'pubspec.yaml'))) await git(dir, 'checkout', 'HEAD', '--', 'pubspec.yaml');

    log(`Intento ${attempt}/${MAX_ATTEMPTS}: Claude implementa la solicitud`);
    const out = await deps.runner.implement({ cwd: dir, app, request: req, attempt, feedback });
    if (out.costUsd !== undefined) log(`Costo del intento: $${out.costUsd.toFixed(3)}`);
    if (out.refused) throw new Stop('discarded', `La IA no la implementó: ${out.refused}`);

    const gate = await checkDiff(dir, app.allowedPaths);
    log(`Diff: ${gate.files.length} archivos, +${gate.added}/-${gate.removed}`);
    if (gate.files.length === 0) {
      feedback = 'You did not change any file. Implement the request, or refuse it with RECHAZO: and a reason.';
      log('Sin cambios');
      continue;
    }
    if (!gate.ok) {
      log(`Revisión del diff rechazada: ${gate.problems.join('; ')}`);
      await git(dir, 'reset', '--hard', 'HEAD');
      await git(dir, 'clean', '-fd');
      feedback = `Your change was rejected and undone. Problems:\n- ${gate.problems.join('\n- ')}`;
      continue;
    }

    await bumpVersion(deps.db, app, dir, log);
    const check = await verify(app, dir, log);
    if (check.ok) return out.summary || 'Cambio implementado.';
    feedback = check.feedback;
  }
  throw new Stop('failed', `No pasó la verificación después de ${MAX_ATTEMPTS} intentos.`);
}

/** Admin-initiated revert of a previous build's commit; no AI involved. */
async function prepareRevert(dir: string, req: Request, log: (l: string) => void): Promise<string> {
  if (!req.revertSha) throw new Stop('failed', 'Falta el commit a revertir.');
  log(`Revirtiendo ${req.revertSha.slice(0, 7)}`);
  const r = await run('git', ['revert', '--no-commit', req.revertSha], { cwd: dir });
  if (r.code !== 0) {
    const conflicted = (await git(dir, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
    // Every build bumps pubspec.yaml's version, so that conflict is expected: keep HEAD's.
    if (conflicted.length > 0 && conflicted.every((f) => f === 'pubspec.yaml')) {
      await git(dir, 'checkout', '--ours', '--', 'pubspec.yaml');
      await git(dir, 'add', 'pubspec.yaml');
    } else {
      throw new Stop('failed', `No se pudo revertir: conflicto en ${conflicted.join(', ') || 'el repo'}.`);
    }
  }
  return `Se revirtió el cambio ${req.revertSha.slice(0, 7)}.`;
}

async function verify(app: App, dir: string, log: (l: string) => void): Promise<{ ok: true } | { ok: false; feedback: string }> {
  for (const [name, cmd] of [
    ['Pruebas', app.testCmd],
    ['Compilación', app.buildCmd],
  ] as const) {
    log(`${name}: ${cmd}`);
    const r = await runShell(cmd, { cwd: dir, timeoutMs: STEP_TIMEOUT_MS });
    if (r.code !== 0) {
      log(`${name} fallaron (${r.timedOut ? 'tiempo agotado' : `código ${r.code}`})\n${tail(r.output, 3000)}`);
      return { ok: false, feedback: `${name} failed:\n${tail(r.output, 8000)}` };
    }
  }
  if (!fs.existsSync(path.join(dir, app.apkPath))) {
    return { ok: false, feedback: `The build did not produce ${app.apkPath}.` };
  }
  return { ok: true };
}

/** Sets pubspec.yaml's build number to one above every APK published so far. */
async function bumpVersion(db: Db, app: App, dir: string, log: (l: string) => void): Promise<number> {
  const file = path.join(dir, 'pubspec.yaml');
  const next = maxVersionCode(db, app.slug) + 1;
  if (!fs.existsSync(file)) return next;
  const text = fs.readFileSync(file, 'utf8');
  // [ \t]* (not \s*): \s would also swallow the newline and the blank line after it.
  const m = text.match(/^version:[ \t]*([^\s+]+)(?:\+(\d+))?[ \t]*$/m);
  if (!m) return next;
  const code = Math.max(next, Number(m[2] ?? 0) + 1);
  fs.writeFileSync(file, text.replace(m[0], `version: ${m[1]}+${code}`));
  log(`Versión ${m[1]}+${code}`);
  return code;
}

function readVersionCode(dir: string): number {
  const file = path.join(dir, 'pubspec.yaml');
  if (!fs.existsSync(file)) return 0;
  const m = fs.readFileSync(file, 'utf8').match(/^version:\s*[^\s+]+\+(\d+)/m);
  return m ? Number(m[1]) : 0;
}

/**
 * Commits locally and pushes to the app's branch. If the branch moved in the
 * meantime, rebases the local (never pushed) commit and verifies again.
 * Never force-pushes.
 */
async function commitAndPush(
  deps: PipelineDeps,
  app: App,
  req: Request,
  dir: string,
  summary: string,
  log: (l: string) => void,
): Promise<number> {
  let versionCode = readVersionCode(dir);
  if (req.kind === 'revert') {
    versionCode = await bumpVersion(deps.db, app, dir, log);
    const check = await verify(app, dir, log);
    if (!check.ok) throw new Stop('failed', 'El código revertido no pasó la verificación.');
  }
  if (!versionCode) versionCode = maxVersionCode(deps.db, app.slug) + 1;

  await git(dir, 'add', '-A');
  const subject =
    req.kind === 'revert'
      ? `revert: ${req.text}`
      : `feat(brain): ${req.text.replace(/\s+/g, ' ').slice(0, 60)}${req.text.length > 60 ? '…' : ''}`;
  const body = [`Request #${req.id}${req.userName ? ` from ${req.userName}` : ''} via coordinating-brain.`, '', summary].join('\n');
  await git(dir, 'commit', '-m', subject, '-m', body);

  await git(dir, 'fetch', 'origin', app.branch);
  const upToDate = await run('git', ['merge-base', '--is-ancestor', `origin/${app.branch}`, 'HEAD'], { cwd: dir });
  if (upToDate.code !== 0) {
    log(`${app.branch} cambió mientras se trabajaba; rebase del commit local`);
    const rb = await run('git', ['rebase', `origin/${app.branch}`], { cwd: dir });
    if (rb.code !== 0) {
      await run('git', ['rebase', '--abort'], { cwd: dir });
      throw new Stop('failed', `${app.branch} cambió y el cambio ya no aplica limpio.`);
    }
    const check = await verify(app, dir, log);
    if (!check.ok) throw new Stop('failed', `Después de actualizar con ${app.branch}, ya no pasa la verificación.`);
  }

  log(`Push a ${app.branch}`);
  const push = await run('git', ['push', 'origin', `HEAD:${app.branch}`], { cwd: dir, timeoutMs: 5 * 60 * 1000 });
  if (push.code !== 0) throw new Stop('failed', `No se pudo subir a ${app.branch}: ${tail(push.output, 500)}`);
  return versionCode;
}

/** Copies the APK into the published folder; returns its file name. */
function publishApk(config: Config, app: App, dir: string, versionCode: number, sha: string): string {
  return storeApk(config.apksDir, app.slug, path.join(dir, app.apkPath), versionCode, sha);
}

export function storeApk(apksDir: string, slug: string, source: string, versionCode: number, sha: string): string {
  const destDir = path.join(apksDir, slug);
  fs.mkdirSync(destDir, { recursive: true });
  const name = `${slug}-v${versionCode}-${sha.slice(0, 7)}.apk`;
  const tmp = path.join(destDir, `.${name}.tmp`);
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, path.join(destDir, name));
  return name;
}
