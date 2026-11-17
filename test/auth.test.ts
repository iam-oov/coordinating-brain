import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCKOUT_MS, MAX_FAILURES, loginWithCode } from '../src/auth.ts';
import { createUser } from '../src/store.ts';
import { makeRemoteApp, registerApp, testSetup } from './helpers.ts';

function setup() {
  const { db } = testSetup();
  registerApp(db, makeRemoteApp().app);
  const code = createUser(db, 'osvaldo', ['demo']);
  return { db, code };
}

test('codes are 4 digits and stored only as a hash', () => {
  const { db, code } = setup();
  assert.match(code, /^\d{4}$/);
  const row = db.prepare('SELECT code_hash, code_salt FROM users').get() as { code_hash: string; code_salt: string };
  assert.notEqual(row.code_hash, code);
  assert.equal(row.code_hash.length, 64);
});

test('the right code logs in', () => {
  const { db, code } = setup();
  const r = loginWithCode(db, code, '1.1.1.1');
  assert.equal(r.kind, 'ok');
});

test(`after ${MAX_FAILURES} failures the IP is blocked, even with the right code`, () => {
  const { db, code } = setup();
  const wrong = code === '0000' ? '0001' : '0000';
  const now = 1_000_000;
  for (let i = 1; i < MAX_FAILURES; i++) assert.equal(loginWithCode(db, wrong, '1.1.1.1', now + i).kind, 'invalid');
  assert.equal(loginWithCode(db, wrong, '1.1.1.1', now + MAX_FAILURES).kind, 'blocked');
  // 6th attempt: correct code, still blocked.
  const sixth = loginWithCode(db, code, '1.1.1.1', now + 10);
  assert.equal(sixth.kind, 'blocked');
  assert.ok(sixth.kind === 'blocked' && sixth.retryAfter > 0);
  // Another IP is not affected.
  assert.equal(loginWithCode(db, code, '2.2.2.2', now + 10).kind, 'ok');
  // After the window, the right code works again.
  assert.equal(loginWithCode(db, code, '1.1.1.1', now + MAX_FAILURES + LOCKOUT_MS + 1).kind, 'ok');
});

test('a success clears earlier failures', () => {
  const { db, code } = setup();
  const wrong = code === '0000' ? '0001' : '0000';
  for (let i = 0; i < MAX_FAILURES - 1; i++) loginWithCode(db, wrong, '1.1.1.1');
  assert.equal(loginWithCode(db, code, '1.1.1.1').kind, 'ok');
  assert.equal(loginWithCode(db, wrong, '1.1.1.1').kind, 'invalid');
});

test('malformed codes never match and count as failures', () => {
  const { db } = setup();
  assert.equal(loginWithCode(db, '12a4', '3.3.3.3').kind, 'invalid');
  assert.equal(loginWithCode(db, '', '3.3.3.3').kind, 'invalid');
});

test('each user gets a different code', () => {
  const { db, code } = setup();
  const other = createUser(db, 'ana', ['demo']);
  assert.notEqual(other, code);
});
