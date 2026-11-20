import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCKOUT_MS, MAX_FAILURES, consumeOAuthState, createOAuthState, recordFailure, retryAfterSeconds } from '../src/auth.ts';
import { linkUserEmail, upsertGoogleUser } from '../src/store.ts';
import { fakeGoogle, makeRemoteApp, registerApp, testSetup } from './helpers.ts';

const IDENTITY = { sub: 'g-1', email: 'ana@example.test', name: 'Ana' };

function setup() {
  const { db } = testSetup();
  registerApp(db, makeRemoteApp().app);
  return db;
}

test('the verifier accepts a valid Google ID token and normalizes the email', async () => {
  const g = await fakeGoogle();
  const token = await g.signIdToken({ sub: 'g-1', email: 'Ana@Example.TEST', name: 'Ana' });
  assert.deepEqual(await g.auth.verifier.verify(token), { sub: 'g-1', email: 'ana@example.test', name: 'Ana' });
});

test('the verifier rejects wrong audience, issuer, unverified email, expiry and nonce', async () => {
  const g = await fakeGoogle();
  const base = { sub: 'g-1', email: 'ana@example.test' };
  const bad = [
    await g.signIdToken({ ...base, audience: 'someone-else' }),
    await g.signIdToken({ ...base, issuer: 'https://evil.example' }),
    await g.signIdToken({ ...base, emailVerified: false }),
    await g.signIdToken({ ...base, expiresIn: '-1m' }),
    'not-a-jwt',
  ];
  for (const t of bad) await assert.rejects(g.auth.verifier.verify(t));
  const withNonce = await g.signIdToken({ ...base, nonce: 'n1' });
  await assert.rejects(g.auth.verifier.verify(withNonce, 'n2'));
  assert.equal((await g.auth.verifier.verify(withNonce, 'n1')).sub, 'g-1');
});

test('the verifier rejects a token signed by another key', async () => {
  const g = await fakeGoogle();
  const other = await fakeGoogle();
  const forged = await other.signIdToken({ sub: 'g-1', email: 'ana@example.test' });
  await assert.rejects(g.auth.verifier.verify(forged));
});

test('a new Google account becomes a user; the same subject finds it again', () => {
  const db = setup();
  const first = upsertGoogleUser(db, IDENTITY, false);
  assert.ok(first.ok && first.created);
  const again = upsertGoogleUser(db, { ...IDENTITY, email: 'ana2@example.test' }, false);
  assert.ok(again.ok && !again.created && again.user.id === (first.ok ? first.user.id : -1));
  assert.equal(again.ok && again.user.email, 'ana2@example.test');
});

test('a legacy user is linked by email; an unlinked admin is refused instead of duplicated', () => {
  const db = setup();
  db.prepare("INSERT INTO users (name, created_at) VALUES ('osvaldo', 0)").run();
  const admin = { sub: 'g-admin', email: 'osvaldo@example.test', name: 'Osvaldo' };
  assert.deepEqual(upsertGoogleUser(db, admin, true), { ok: false, error: 'admin-unlinked' });

  linkUserEmail(db, 'osvaldo', 'Osvaldo@Example.test');
  const linked = upsertGoogleUser(db, admin, true);
  assert.ok(linked.ok && !linked.created);
  assert.equal(linked.ok && linked.user.name, 'osvaldo');
  assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n, 1);
});

test('a disabled user cannot sign in', () => {
  const db = setup();
  upsertGoogleUser(db, IDENTITY, false);
  db.prepare('UPDATE users SET enabled = 0').run();
  assert.deepEqual(upsertGoogleUser(db, IDENTITY, false), { ok: false, error: 'disabled' });
});

test(`after ${MAX_FAILURES} failures the IP waits until the window passes`, () => {
  const db = setup();
  const now = 1_000_000;
  for (let i = 0; i < MAX_FAILURES; i++) recordFailure(db, '1.1.1.1', now + i);
  assert.ok(retryAfterSeconds(db, '1.1.1.1', now + 10) > 0);
  assert.equal(retryAfterSeconds(db, '2.2.2.2', now + 10), 0);
  assert.equal(retryAfterSeconds(db, '1.1.1.1', now + MAX_FAILURES + LOCKOUT_MS + 1), 0);
});

test('an OAuth state works once, only from the browser that started it, and expires', () => {
  const db = setup();
  const now = 5_000_000;
  const a = createOAuthState(db, '/admin', null, now);
  assert.equal(consumeOAuthState(db, a.state, 'other-browser', now), null);
  assert.equal(consumeOAuthState(db, a.state, a.browserToken, now), null);

  const b = createOAuthState(db, '/apks', 'demo', now);
  const ok = consumeOAuthState(db, b.state, b.browserToken, now + 1000);
  assert.deepEqual(ok, { verifier: b.verifier, nonce: b.nonce, next: '/apks', appSlug: 'demo' });
  assert.equal(consumeOAuthState(db, b.state, b.browserToken, now + 2000), null);

  const c = createOAuthState(db, '/apks', null, now);
  assert.equal(consumeOAuthState(db, c.state, c.browserToken, now + 11 * 60 * 1000), null);
});
