import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { Config } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import { openDb } from '../src/db.ts';
import type { App } from '../src/store.ts';
import { upsertApp } from '../src/store.ts';

export const ADMIN_PASSWORD = 'una-clave-larga-de-prueba-123';

export function tempDir(prefix = 'brain-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testSetup(): { config: Config; db: Db; dir: string } {
  const dir = tempDir();
  const config = loadConfig({
    DATA_DIR: dir,
    ADMIN_PASSWORD,
    PUBLIC_URL: 'https://cerebro.example.test',
  } as NodeJS.ProcessEnv);
  const db = openDb(config.dbPath);
  return { config, db, dir };
}

export function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitInit(dir: string): void {
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', 'config', 'user.name', 'Test');
  sh(dir, 'git', 'config', 'user.email', 'test@example.test');
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false');
}

/**
 * A bare "remote" with a tiny app: tests fail if any file in lib/ contains
 * BROKEN, and the build writes out/app.apk.
 */
export function makeRemoteApp(): { remote: string; app: App } {
  const root = tempDir('brain-remote-');
  const remote = path.join(root, 'app.git');
  const seed = path.join(root, 'seed');
  sh(root, 'git', 'init', '-q', '--bare', '-b', 'main', remote);
  fs.mkdirSync(path.join(seed, 'lib'), { recursive: true });
  gitInit(seed);
  fs.writeFileSync(path.join(seed, 'pubspec.yaml'), 'name: demo\nversion: 1.0.0+1\n\nenvironment:\n  sdk: ^3.0.0\n');
  fs.writeFileSync(path.join(seed, 'lib', 'main.dart'), 'void main() {}\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'out/\n');
  sh(seed, 'git', 'add', '-A');
  sh(seed, 'git', 'commit', '-q', '-m', 'init');
  sh(seed, 'git', 'remote', 'add', 'origin', remote);
  sh(seed, 'git', 'push', '-q', 'origin', 'main');
  const app: App = {
    slug: 'demo',
    name: 'Demo',
    repoUrl: remote,
    branch: 'main',
    allowedPaths: ['lib/', 'test/'],
    testCmd: '! grep -r BROKEN lib',
    buildCmd: 'mkdir -p out && echo apk > out/app.apk',
    apkPath: 'out/app.apk',
  };
  return { remote, app };
}

export function registerApp(db: Db, app: App): void {
  upsertApp(db, app);
}

/** Files and last commit subject of the remote's main branch. */
export function remoteState(remote: string): { subject: string; files: string[]; pubspec: string; log: string[] } {
  const clone = path.join(tempDir('brain-check-'), 'c');
  sh(path.dirname(clone), 'git', 'clone', '-q', remote, clone);
  return {
    subject: sh(clone, 'git', 'log', '-1', '--format=%s'),
    files: sh(clone, 'git', 'ls-files').split('\n'),
    pubspec: fs.readFileSync(path.join(clone, 'pubspec.yaml'), 'utf8'),
    log: sh(clone, 'git', 'log', '--format=%s').split('\n'),
  };
}
