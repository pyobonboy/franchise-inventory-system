'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-crypto-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { knex, initDb, teardown, createBrand, createStore } = require('./helpers');

const CRYPTO_PATH = require.resolve('../src/crypto');
const BACKFILL_PATH = require.resolve('../src/credentialsBackfill');

const KEY_A = '1'.repeat(64);
const KEY_B = '2'.repeat(64);

// crypto.js는 모듈 최초 require 시점에 CREDENTIALS_KEY를 캐시(cachedKey)하므로, env를 바꿔가며
// 서로 다른 키 상태를 검증하려면 매번 require 캐시를 비우고 다시 불러야 한다.
function freshCrypto(keyEnvValue) {
  delete require.cache[CRYPTO_PATH];
  if (keyEnvValue === undefined) delete process.env.CREDENTIALS_KEY;
  else process.env.CREDENTIALS_KEY = keyEnvValue;
  return require('../src/crypto');
}

let brandId;

before(async () => {
  await initDb();
  brandId = await createBrand();
});

after(async () => {
  delete process.env.CREDENTIALS_KEY;
  await teardown();
});

test('키 없이 decryptCredential("평문")은 평문 그대로 반환한다', () => {
  const c = freshCrypto(undefined);
  assert.equal(c.decryptCredential('그냥평문시크릿'), '그냥평문시크릿');
  assert.equal(c.hasKey(), false);
});

test('CREDENTIALS_KEY 설정 시 encryptCredential → decryptCredential 왕복이 원문을 복원한다', () => {
  const c = freshCrypto(KEY_A);
  const plain = '아주비밀스러운시크릿123';
  const encrypted = c.encryptCredential(plain);
  assert.notEqual(encrypted, plain);
  assert.ok(encrypted.startsWith(c.PREFIX));
  assert.equal(c.decryptCredential(encrypted), plain);
});

test('isEncrypted가 enc:v1: 접두사로만 암호화 여부를 판별해 이중 암호화 가드를 가능하게 한다', () => {
  const c = freshCrypto(KEY_A);
  const plain = '평문값';
  const encrypted = c.encryptCredential(plain);
  assert.equal(c.isEncrypted(encrypted), true);
  assert.equal(c.isEncrypted(plain), false);
});

test('잘못된 키로 복호화하면 조용히 깨진 값을 반환하지 않고 명확한 예외를 던진다', () => {
  const c1 = freshCrypto(KEY_A);
  const encrypted = c1.encryptCredential('원본시크릿');

  const c2 = freshCrypto(KEY_B);
  assert.throws(() => c2.decryptCredential(encrypted), /복호화 실패/);
});

test('credentialsBackfill을 두 번 돌려도 결과가 동일하다 (멱등성)', async () => {
  delete require.cache[CRYPTO_PATH];
  delete require.cache[BACKFILL_PATH];
  process.env.CREDENTIALS_KEY = KEY_A;
  const cryptoModule = require('../src/crypto');
  const { backfillCredentials } = require('../src/credentialsBackfill');

  const plainSecret = `평문웹훅시크릿_${Date.now()}`;
  const storeId = await createStore(brandId, { webhook_secret: plainSecret });

  await backfillCredentials(knex);
  const afterFirst = await knex('stores').where({ id: storeId }).first();
  assert.ok(cryptoModule.isEncrypted(afterFirst.webhook_secret), '첫 백필 후 암호화되어야 한다');
  assert.equal(cryptoModule.decryptCredential(afterFirst.webhook_secret), plainSecret);

  await backfillCredentials(knex);
  const afterSecond = await knex('stores').where({ id: storeId }).first();
  assert.equal(afterSecond.webhook_secret, afterFirst.webhook_secret, '두 번째 백필은 값을 바꾸지 않아야 한다(이중 암호화 없음)');
});
