import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.ts';
import { isAdminEmail } from '../config.ts';
import type { Db } from '../db.ts';
import type { App, Request } from '../store.ts';
import {
  addBuild,
  appendLog,
  buildForRequest,
  finishRequest,
  getApp,
  getUser,
  maxVersionCode,
  recordPushedSha,
  saveReview,
} from '../store.ts';
import { checkDiff, gateRules } from './diffGate.ts';
import { git, run, runShell, tail } from './exec.ts';
import type { AgentRunner } from './runner.ts';
import type { TestSandbox } from './sandbox.ts';

export const MAX_ATTEMPTS = 3;
const STEP_TIMEOUT_MS = 30 * 60 * 1000;

export interface PipelineDeps {
  db: Db;
  config: Config;
  runner: AgentRunner;
  sandbox: TestSandbox;
}

class Stop extends Error {
  readonly status: 'failed' | 'discarded';
  constructor(status: 'failed' | 'discarded', reason: string) {
    super(reason);
    this.status = status;
  }
}

interface Job {
  deps: PipelineDeps;
  app: App;
  req: Request;
  dir: string;
  log: (line: string) => void;
}

/**
 * Runs one approved request end to end. A request lands on its author's branch
 * (users/<id>); an admin's request marked "also main" lands on main first and is
 * then carried to the admin's branch. Each push is recorded, so a request picked
 * up again after a restart only republishes and never calls the AI twice.
 */
export async function processRequest(deps: PipelineDeps, req: Request): Promise<void> {
  const { db, config } = deps;
  const log = (line: string) => appendLog(db, req.id, line);
  const app = getApp(db, req.appSlug);
  const dir = path.join(config.workDir, `${req.appSlug}-${req.id}`);

  try {
    if (!app) throw new Stop('failed', `La app ${req.appSlug} ya no existe.`);
    const job: Job = { deps, app, req, dir, log };
    const reviewFirst = req.forced && !req.reviewOk;
    const targets = reviewFirst ? [] : planTargets(job);
    fs.mkdirSync(config.workDir, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    log(`Clonando ${app.repoUrl} (${app.branch})`);
    await git(config.workDir, 'clone', '--branch', app.branch, '--single-branch', app.repoUrl, dir);
    await git(dir, 'config', 'user.name', config.gitAuthorName);
    await git(dir, 'config', 'user.email', config.gitAuthorEmail);

    if (reviewFirst) {
      await prepareReview(job);
      return;
    }

    let summary = 'Cambio implementado.';
    let firstSha = '';
    for (const [i, branch] of targets.entries()) {
      const recorded = pushedSha(job, branch);
      if (recorded) {
        firstSha ||= recorded;
        await resumeTarget(job, branch, recorded);
      } else if (i === 0) {
        ({ summary, sha: firstSha } = await implementOn(job, branch));
      } else {
        await carryToBranch(job, branch, firstSha);
      }
    }
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

function authorIsAdmin({ deps, req }: Job): boolean {
  return req.userId !== null && isAdminEmail(deps.config, getUser(deps.db, req.userId)?.email);
}

function mayPushMain(job: Job): boolean {
  const { req } = job;
  return req.kind === 'revert' || (req.alsoMain && authorIsAdmin(job)) || (req.forced && req.reviewOk);
}

function planTargets(job: Job): string[] {
  const { app, req } = job;
  const toMainFirst = req.kind === 'change' && (req.alsoMain || req.forced) && req.branch !== app.branch;
  const targets = toMainFirst ? [app.branch, req.branch] : [req.branch];
  if (targets.includes(app.branch) && !mayPushMain(job)) {
    throw new Stop('failed', `Solo una solicitud de un admin puede ir a ${app.branch}.`);
  }
  return targets;
}

function pushedSha({ app, req }: Job, branch: string): string | null {
  return branch === app.branch ? req.mainSha : req.branchSha;
}

async function implementOn(job: Job, branch: string): Promise<{ summary: string; sha: string }> {
  const { deps, app, req, dir, log } = job;
  await checkoutTarget(job, branch);
  let summary: string;
  if (req.kind === 'revert') {
    summary = await prepareRevert(dir, req, log);
    await bumpVersion(deps.db, app, dir, log);
    const check = await verify(job);
    if (!check.ok) throw new Stop('failed', 'El código revertido no pasó la verificación.');
  } else if (req.forced) {
    summary = req.reason || 'Cambio forzado por el admin.';
    await applyReviewedPatch(job);
    await bumpVersion(deps.db, app, dir, log);
    const check = await verify(job);
    if (!check.ok) throw new Stop('failed', 'El cambio revisado no pasó la verificación al compilarlo.');
  } else {
    summary = await implementWithRetries(job, 'publish');
  }
  const sha = await commitPushPublish(job, branch, summary);
  return { summary, sha };
}

async function prepareReview(job: Job): Promise<void> {
  const { deps, app, req, dir, log } = job;
  await checkoutTarget(job, app.branch);
  const summary = await implementWithRetries(job, 'review');
  await git(dir, 'add', '-A');
  const diff = await run('git', ['diff', '--cached', '--binary', 'HEAD'], { cwd: dir });
  if (diff.code !== 0) throw new Error(`git diff failed: ${tail(diff.output, 500)}`);
  saveReview(deps.db, req.id, diff.output, summary);
  log('Pruebas aprobadas en el sandbox. Espera la revisión del diff en /admin antes de compilar y publicar.');
}

async function applyReviewedPatch({ req, dir, log }: Job): Promise<void> {
  if (!req.reviewPatch) throw new Stop('failed', 'Falta el diff revisado.');
  log('Aplicando el diff revisado por el admin');
  const r = await run('git', ['apply', '--3way', '--index', '-'], { cwd: dir, input: req.reviewPatch });
  if (r.code !== 0) {
    throw new Stop('failed', `El diff revisado ya no aplica sobre main; fuérzala de nuevo. ${tail(r.output, 300)}`);
  }
}

/** Brings the change already on main to the admin's own branch. Problems here never undo main. */
async function carryToBranch(job: Job, branch: string, mainSha: string): Promise<void> {
  const { deps, app, dir, log } = job;
  try {
    const existed = await checkoutTarget(job, branch);
    if (!existed) {
      await pushTo(job, branch, mainSha);
      const mainBuild = buildForRequest(deps.db, job.req.id, app.branch);
      if (mainBuild) addBuild(deps.db, { ...mainBuild, branch });
      log(`${branch} se creó desde ${app.branch} con su mismo APK`);
      return;
    }
    log(`Aplicando el cambio también a ${branch}`);
    const pick = await run('git', ['cherry-pick', '--no-commit', mainSha], { cwd: dir });
    if (pick.code !== 0) {
      const conflicted = await conflictedFiles(dir);
      if (conflicted.length === 0 || !conflicted.every((f) => f === 'pubspec.yaml')) {
        throw new Error(`conflicto en ${conflicted.join(', ') || 'el repo'}`);
      }
      await keepOurPubspec(dir);
    }
    await git(dir, 'add', '-A');
    const nothingStaged = (await run('git', ['diff', '--cached', '--quiet'], { cwd: dir })).code === 0;
    const coreSynced = Number(await git(dir, 'rev-list', '--count', `origin/${branch}..HEAD`)) > 0;
    if (nothingStaged && !coreSynced) {
      log(`${branch} ya tenía el cambio`);
      return;
    }
    await bumpVersion(deps.db, app, dir, log);
    const check = await verify(job);
    if (!check.ok) throw new Error('no pasó la verificación');
    await commitPushPublish(job, branch, `Mismo cambio que ${app.branch} (${mainSha.slice(0, 7)}).`);
  } catch (e) {
    log(`No llegó a ${branch}: ${(e as Error).message}`);
    await cleanTree(dir);
  }
}

/** A target pushed before a restart: publish its APK if that never happened. */
async function resumeTarget(job: Job, branch: string, sha: string): Promise<void> {
  const { deps, app, req, dir, log } = job;
  log(`${branch} ya tenía ${sha.slice(0, 7)}; no se vuelve a implementar`);
  if (buildForRequest(deps.db, req.id, branch)) return;
  if (branch !== app.branch && sha === req.mainSha) {
    const mainBuild = buildForRequest(deps.db, req.id, app.branch);
    if (mainBuild) addBuild(deps.db, { ...mainBuild, branch });
    return;
  }
  await fetchBranch(dir, branch);
  await git(dir, 'checkout', '-q', '--detach', sha);
  const check = await verify(job);
  if (!check.ok) throw new Stop('failed', `El commit ${sha.slice(0, 7)} de ${branch} no compiló al republicar.`);
  publish(job, branch, readVersionCode(dir) || maxVersionCode(deps.db, app.slug) + 1, sha);
}

async function fetchBranch(dir: string, branch: string): Promise<boolean> {
  const r = await run('git', ['fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
    cwd: dir,
    timeoutMs: 10 * 60 * 1000,
  });
  return r.code === 0;
}

/** Checks out [branch] fresh from the remote, or creates it from main. Returns whether it existed. */
async function checkoutTarget(job: Job, branch: string): Promise<boolean> {
  const { app, dir } = job;
  await cleanTree(dir);
  await fetchBranch(dir, app.branch);
  if (branch === app.branch) {
    await git(dir, 'checkout', '-q', '-B', branch, `origin/${branch}`);
    return true;
  }
  const exists = (await run('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: dir })).code === 0;
  if (!exists) {
    await git(dir, 'checkout', '-q', '-B', branch, `origin/${app.branch}`);
    return false;
  }
  await fetchBranch(dir, branch);
  await git(dir, 'checkout', '-q', '-B', branch, `origin/${branch}`);
  await syncCore(job);
  return true;
}

/**
 * Makes everything outside the user-editable folders, plus the protected core,
 * match main again. The branch keeps its own features and version number.
 */
export async function syncCore({ app, dir, log }: Pick<Job, 'app' | 'dir' | 'log'>): Promise<boolean> {
  const main = `origin/${app.branch}`;
  const version = readVersionLine(dir);
  const excludes = app.allowedPaths.map((p) => `:(exclude)${p}`);
  await git(dir, 'restore', `--source=${main}`, '--staged', '--worktree', '--', '.', ...excludes);
  for (const p of app.protectedPaths) {
    if ((await trackedIn(dir, main, p)) || (await trackedIn(dir, 'HEAD', p))) {
      await git(dir, 'restore', `--source=${main}`, '--staged', '--worktree', '--', p);
    }
  }
  if (version) writeVersionLine(dir, version);
  await git(dir, 'add', '-A');
  if ((await run('git', ['diff', '--cached', '--quiet'], { cwd: dir })).code === 0) return false;
  const short = await git(dir, 'rev-parse', '--short=7', main);
  await git(dir, 'commit', '-q', '-m', `chore(core): sync from ${app.branch} ${short}`);
  log(`Núcleo sincronizado desde ${app.branch} (${short})`);
  return true;
}

async function trackedIn(dir: string, ref: string, p: string): Promise<boolean> {
  return (await git(dir, 'ls-tree', '-r', '--name-only', ref, '--', p)).length > 0;
}

async function cleanTree(dir: string): Promise<void> {
  await run('git', ['cherry-pick', '--quit'], { cwd: dir });
  await git(dir, 'reset', '-q', '--hard');
  await git(dir, 'clean', '-fdq');
}

async function conflictedFiles(dir: string): Promise<string[]> {
  return (await git(dir, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
}

/** Every build bumps pubspec.yaml's version, so that conflict is expected: keep ours. */
async function keepOurPubspec(dir: string): Promise<void> {
  await git(dir, 'checkout', '--ours', '--', 'pubspec.yaml');
  await git(dir, 'add', 'pubspec.yaml');
}

async function implementWithRetries(job: Job, mode: 'review' | 'publish'): Promise<string> {
  const { deps, app, req, dir, log } = job;
  let feedback: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (mode === 'publish' && fs.existsSync(path.join(dir, 'pubspec.yaml'))) {
      await git(dir, 'checkout', 'HEAD', '--', 'pubspec.yaml');
    }

    log(`Intento ${attempt}/${MAX_ATTEMPTS}: Claude implementa la solicitud`);
    const out = await deps.runner.implement({ cwd: dir, app, request: req, attempt, feedback });
    if (out.costUsd !== undefined) log(`Costo del intento: $${out.costUsd.toFixed(3)}`);
    if (out.refused) throw new Stop('discarded', `La IA no la implementó: ${out.refused}`);

    const gate = await checkDiff(dir, gateRules(app, req.forced));
    log(`Diff: ${gate.files.length} archivos, +${gate.added}/-${gate.removed}`);
    if (gate.files.length === 0) {
      feedback = 'You did not change any file. Implement the request, or refuse it with RECHAZO: and a reason.';
      log('Sin cambios');
      continue;
    }
    if (!gate.ok) {
      log(`Revisión del diff rechazada: ${gate.problems.join('; ')}`);
      await git(dir, 'reset', '-q', '--hard', 'HEAD');
      await git(dir, 'clean', '-fdq');
      feedback = `Your change was rejected and undone. Problems:\n- ${gate.problems.join('\n- ')}`;
      continue;
    }

    if (mode === 'publish') await bumpVersion(deps.db, app, dir, log);
    const check = await verify(job, mode === 'publish');
    if (check.ok) return out.summary || 'Cambio implementado.';
    feedback = check.feedback;
  }
  throw new Stop('failed', `No pasó la verificación después de ${MAX_ATTEMPTS} intentos.`);
}

async function prepareRevert(dir: string, req: Request, log: (l: string) => void): Promise<string> {
  if (!req.revertSha) throw new Stop('failed', 'Falta el commit a revertir.');
  log(`Revirtiendo ${req.revertSha.slice(0, 7)}`);
  const r = await run('git', ['revert', '--no-commit', req.revertSha], { cwd: dir });
  if (r.code !== 0) {
    const conflicted = await conflictedFiles(dir);
    if (conflicted.length > 0 && conflicted.every((f) => f === 'pubspec.yaml')) await keepOurPubspec(dir);
    else throw new Stop('failed', `No se pudo revertir: conflicto en ${conflicted.join(', ') || 'el repo'}.`);
  }
  return `Se revirtió el cambio ${req.revertSha.slice(0, 7)}.`;
}

/** Prepare and build are trusted app config; the tests run the AI's code, so they go to the sandbox. */
async function verify({ deps, app, dir, log }: Job, build = true): Promise<{ ok: true } | { ok: false; feedback: string }> {
  const steps = [
    ['Preparación', app.prepareCmd, false],
    ['Pruebas', app.testCmd, true],
    ['Compilación', build ? app.buildCmd : '', false],
  ] as const;
  for (const [name, cmd, sandboxed] of steps) {
    if (!cmd) continue;
    log(`${name}: ${cmd}`);
    const r = sandboxed
      ? await deps.sandbox.run(dir, cmd, STEP_TIMEOUT_MS)
      : await runShell(cmd, { cwd: dir, timeoutMs: STEP_TIMEOUT_MS });
    if (r.code !== 0) {
      log(`${name} fallaron (${r.timedOut ? 'tiempo agotado' : `código ${r.code}`})\n${tail(r.output, 3000)}`);
      return { ok: false, feedback: `${name} failed:\n${tail(r.output, 8000)}` };
    }
  }
  if (build && !fs.existsSync(path.join(dir, app.apkPath))) {
    return { ok: false, feedback: `The build did not produce ${app.apkPath}.` };
  }
  return { ok: true };
}

/** Sets pubspec.yaml's build number above every APK of the app, on any branch. */
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

const VERSION_LINE = /^version:[^\n]*$/m;

function readVersionLine(dir: string): string | null {
  const file = path.join(dir, 'pubspec.yaml');
  return fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').match(VERSION_LINE)?.[0] ?? null) : null;
}

function writeVersionLine(dir: string, line: string): void {
  const file = path.join(dir, 'pubspec.yaml');
  if (!fs.existsSync(file)) return;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(VERSION_LINE, line));
}

function readVersionCode(dir: string): number {
  const m = readVersionLine(dir)?.match(/\+(\d+)/);
  return m ? Number(m[1]) : 0;
}

function commitSubject(req: Request): string {
  if (req.kind === 'revert') return `revert: ${req.text}`;
  const text = req.text.replace(/\s+/g, ' ');
  return `feat(brain): ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`;
}

/**
 * Commits, pushes to [branch] and publishes the APK. If the branch moved in the
 * meantime, rebases the local (never pushed) commit and verifies again.
 * Never force-pushes. The commit names the request, never its author: the repo is public.
 */
async function commitPushPublish(job: Job, branch: string, summary: string): Promise<string> {
  const { deps, app, req, dir, log } = job;
  const versionCode = readVersionCode(dir) || maxVersionCode(deps.db, app.slug) + 1;
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', commitSubject(req), '-m', `Request #${req.id} via coordinating-brain.\n\n${summary}`);

  if (await fetchBranch(dir, branch)) {
    const upToDate = await run('git', ['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'], { cwd: dir });
    if (upToDate.code !== 0) {
      log(`${branch} cambió mientras se trabajaba; rebase del commit local`);
      const rb = await run('git', ['rebase', `origin/${branch}`], { cwd: dir });
      if (rb.code !== 0) {
        await run('git', ['rebase', '--abort'], { cwd: dir });
        throw new Stop('failed', `${branch} cambió y el cambio ya no aplica limpio.`);
      }
      const check = await verify(job);
      if (!check.ok) throw new Stop('failed', `Después de actualizar con ${branch}, ya no pasa la verificación.`);
    }
  }

  const sha = await pushTo(job, branch, 'HEAD');
  publish(job, branch, versionCode, sha);
  return sha;
}

/** The only place that pushes. Main needs mayPushMain; the pushed SHA is recorded right away. */
async function pushTo(job: Job, branch: string, ref: string): Promise<string> {
  const { deps, app, req, dir, log } = job;
  if (branch === app.branch && !mayPushMain(job)) throw new Stop('failed', `Esta solicitud no puede subir a ${branch}.`);
  const sha = await git(dir, 'rev-parse', ref);
  log(`Push a ${branch}`);
  const push = await run('git', ['push', 'origin', `${sha}:refs/heads/${branch}`], { cwd: dir, timeoutMs: 5 * 60 * 1000 });
  if (push.code !== 0) throw new Stop('failed', `No se pudo subir a ${branch}: ${tail(push.output, 500)}`);
  recordPushedSha(deps.db, req.id, branch === app.branch ? 'main' : 'branch', sha);
  return sha;
}

function publish(job: Job, branch: string, versionCode: number, sha: string): void {
  const { deps, app, req, dir, log } = job;
  const subdir = branch === app.branch ? '' : branch;
  const apkFile = storeApk(deps.config.apksDir, app.slug, path.join(dir, app.apkPath), versionCode, sha, subdir);
  addBuild(deps.db, { requestId: req.id, appSlug: app.slug, branch, versionCode, apkFile, commitSha: sha });
  log(`APK publicado: ${apkFile}`);
}

/** Copies the APK under apks/<slug>/<subdir>; returns its path relative to apks/<slug>. */
export function storeApk(apksDir: string, slug: string, source: string, versionCode: number, sha: string, subdir = ''): string {
  const destDir = path.join(apksDir, slug, subdir);
  fs.mkdirSync(destDir, { recursive: true });
  const name = `${slug}-v${versionCode}-${sha.slice(0, 7)}.apk`;
  const tmp = path.join(destDir, `.${name}.tmp`);
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, path.join(destDir, name));
  return subdir ? path.posix.join(subdir, name) : name;
}
