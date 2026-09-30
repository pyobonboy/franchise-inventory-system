'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-auth-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createUser, tokenFor,
} = require('./helpers');

let ctx;
let brandId;
let storeId;

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeId = await createStore(brandId);
});

after(async () => {
  await ctx.close();
  await teardown();
});

async function login(email, password) {
  return fetch(`${ctx.baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

test('로그인 5회 실패 후 6번째 시도는 429로 잠긴다', async () => {
  const user = await createUser({ brand_id: brandId, role: 'HQ_ADMIN', password: 'correct-password-1' });
  for (let i = 0; i < 5; i++) {
    const res = await login(user.email, 'wrong-password');
    assert.equal(res.status, 401, `${i + 1}번째 실패 시도는 401이어야 한다`);
  }
  const sixth = await login(user.email, 'wrong-password');
  assert.equal(sixth.status, 429);

  // 잠긴 상태에서는 올바른 비밀번호를 넣어도 로그인할 수 없어야 한다
  const correctButLocked = await login(user.email, 'correct-password-1');
  assert.equal(correctButLocked.status, 429);
});

test('로그인 실패 응답에는 내부 정보(스택/SQL/컬럼명)가 노출되지 않는다', async () => {
  const res = await login('no-such-user@test.local', 'whatever');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['error']);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /sqlite|stack|at Object|at Module|column|SELECT |INSERT |password_hash/i);
});

test('가맹점 역할 토큰으로 매출 동기화(POST /api/stores/:id/sync)를 호출하면 403', async () => {
  const storeUser = await createUser({ brand_id: brandId, store_id: storeId, role: 'STORE_OWNER' });
  const token = tokenFor(storeUser);
  const res = await fetch(`${ctx.baseUrl}/api/stores/${storeId}/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 403);
});

test('HQ_ADMIN은 SUPER_ADMIN 계정을 수정할 수 없다 (권한 역전 방어)', async () => {
  const superAdmin = await createUser({ brand_id: brandId, role: 'SUPER_ADMIN' });
  const hqAdmin = await createUser({ brand_id: brandId, role: 'HQ_ADMIN' });
  const token = tokenFor(hqAdmin);

  const res = await fetch(`${ctx.baseUrl}/auth/users/${superAdmin.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '권한탈취시도', is_active: false }),
  });
  assert.equal(res.status, 403);

  const stillSame = await knex('users').where({ id: superAdmin.id }).first();
  assert.equal(stillSame.is_active, 1);
});

test('HQ_ADMIN은 SUPER_ADMIN 계정을 삭제할 수 없다 (권한 역전 방어)', async () => {
  const superAdmin = await createUser({ brand_id: brandId, role: 'SUPER_ADMIN' });
  const hqAdmin = await createUser({ brand_id: brandId, role: 'HQ_ADMIN' });
  const token = tokenFor(hqAdmin);

  const res = await fetch(`${ctx.baseUrl}/auth/users/${superAdmin.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 403);

  const stillExists = await knex('users').where({ id: superAdmin.id }).first();
  assert.ok(stillExists, '삭제되지 않고 그대로 남아있어야 한다');
});

test('SUPER_ADMIN은 SUPER_ADMIN 계정을 정상적으로 수정할 수 있다 (대조군)', async () => {
  const superAdmin = await createUser({ brand_id: brandId, role: 'SUPER_ADMIN' });
  const anotherSuperAdmin = await createUser({ brand_id: brandId, role: 'SUPER_ADMIN' });
  const token = tokenFor(anotherSuperAdmin);

  const res = await fetch(`${ctx.baseUrl}/auth/users/${superAdmin.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '정상수정' }),
  });
  assert.equal(res.status, 200);
});
