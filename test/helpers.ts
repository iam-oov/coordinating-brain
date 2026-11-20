import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

import type { Config } from '../src/config.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import { openDb } from '../src/db.ts';
import type { GoogleAuth } from '../src/google.ts';
import { GoogleAuthError, createGoogleVerifier } from '../src/google.ts';
import type { App } from '../src/store.ts';
import { grantApps, upsertApp } from '../src/store.ts';

export const ADMIN_EMAIL = 'admin@example.test';
export const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';

export function tempDir(prefix = 'brain-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testSetup(): { config: Config; db: Db; dir: string } {
  const dir = tempDir();
  const config = loadConfig({
    DATA_DIR: dir,
    ADMIN_EMAILS: ADMIN_EMAIL,
    GOOGLE_WEB_CLIENT_ID: GOOGLE_CLIENT_ID,
    GOOGLE_WEB_CLIENT_SECRET: 'test-secret',
    SANDBOX: 'none',
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

export function createTestUser(db: Db, name: string, email: string, apps: string[], sub = `sub-${email}`): number {
  const res = db
    .prepare('INSERT INTO users (name, email, google_sub, created_at) VALUES (?, ?, ?, ?)')
    .run(name, email, sub, Date.now());
  const id = Number(res.lastInsertRowid);
  grantApps(db, id, apps);
  return id;
}

export interface IdTokenClaims {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  nonce?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}

export interface FakeGoogle {
  auth: GoogleAuth;
  signIdToken(claims: IdTokenClaims): Promise<string>;
  /** Code the fake token endpoint accepts; it answers with a token for [claims]. */
  codeFor(claims: IdTokenClaims): string;
  exchanges: { code: string; verifier: string; redirectUri: string }[];
}

export async function fakeGoogle(): Promise<FakeGoogle> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const codes = new Map<string, IdTokenClaims>();
  const exchanges: FakeGoogle['exchanges'] = [];

  async function signIdToken(c: IdTokenClaims): Promise<string> {
    return new SignJWT({
      email: c.email,
      email_verified: c.emailVerified ?? true,
      ...(c.name ? { name: c.name } : {}),
      ...(c.nonce ? { nonce: c.nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(c.sub)
      .setIssuer(c.issuer ?? 'https://accounts.google.com')
      .setAudience(c.audience ?? GOOGLE_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(c.expiresIn ?? '10m')
      .sign(privateKey);
  }

  return {
    signIdToken,
    exchanges,
    codeFor(claims) {
      const code = `code-${codes.size + 1}`;
      codes.set(code, claims);
      return code;
    },
    auth: {
      clientId: GOOGLE_CLIENT_ID,
      verifier: createGoogleVerifier(GOOGLE_CLIENT_ID, keys),
      exchange: {
        async exchange(code, verifier, redirectUri) {
          exchanges.push({ code, verifier, redirectUri });
          const claims = codes.get(code);
          if (!claims) throw new GoogleAuthError('unknown code');
          return signIdToken(claims);
        },
      },
    },
  };
}
