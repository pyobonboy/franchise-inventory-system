'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-orderperm-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createUser, tokenFor, createIngredient,
} = require('./helpers');

let ctx;
let brandId;
let storeAId; // 내 매장
let storeBId; // 타 매장

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeAId = await createStore(brandId, { name: 'A매장' });
  storeBId = await createStore(brandId, { name: 'B매장' });
});

after(async () => {
  await ctx.close();
  await teardown();
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

test('GET /api/store-rankings — STORE_OWNER 403, HQ_ACCOUNTING 200', async () => {
  const owner = await createUser({ brand_id: brandId, store_id: storeAId, role: 'STORE_OWNER' });
  const accounting = await createUser({ brand_id: brandId, role: 'HQ_ACCOUNTING' });
  const ownerToken = tokenFor(owner);
  const accountingToken = tokenFor(accounting);

  const res1 = await fetch(`${ctx.baseUrl}/api/store-rankings`, { headers: authHeader(ownerToken) });
  assert.equal(res1.status, 403);

  const res2 = await fetch(`${ctx.baseUrl}/api/store-rankings`, { headers: authHeader(accountingToken) });
  assert.equal(res2.status, 200);
});

test('GET /api/dashboard/channel-breakdown?store_id=<타 매장> — STORE_OWNER 요청 시 자기 매장 데이터만', async () => {
  const owner = await createUser({ brand_id: brandId, store_id: storeAId, role: 'STORE_OWNER' });
  const ownerToken = tokenFor(owner);

  await knex('orders').insert({
    brand_id: brandId, store_id: storeAId, toss_order_id: `order_cb_A_${Date.now()}`,
    raw_payload: '{}', order_state: 'COMPLETED', total_amount: 1000, channel: 'POS',
    processed_at: new Date().toISOString(),
  });
  await knex('orders').insert({
    brand_id: brandId, store_id: storeBId, toss_order_id: `order_cb_B_${Date.now()}`,
    raw_payload: '{}', order_state: 'COMPLETED', total_amount: 99999, channel: 'POS',
    processed_at: new Date().toISOString(),
  });

  const res = await fetch(`${ctx.baseUrl}/api/dashboard/channel-breakdown?store_id=${storeBId}`, { headers: authHeader(ownerToken) });
  assert.equal(res.status, 200);
  const body = await res.json();
  const totalRevenue = body.breakdown.reduce((s, r) => s + r.revenue, 0);
  assert.equal(totalRevenue, 1000, '쿼리파라미터로 타 매장을 지정해도 자기 매장 매출만 나와야 한다');
});

test('GET /api/waste/summary — STORE_OWNER가 타 가맹점 폐기 행을 못 받는다', async () => {
  const owner = await createUser({ brand_id: brandId, store_id: storeAId, role: 'STORE_OWNER' });
  const ownerToken = tokenFor(owner);

  await knex('waste_logs').insert({
    brand_id: brandId, store_id: storeAId, ingredient_name: 'A매장폐기재료', quantity: 1, unit: 'g',
    reason: '유통기한', waste_date: '2026-01-01',
  });
  await knex('waste_logs').insert({
    brand_id: brandId, store_id: storeBId, ingredient_name: 'B매장폐기재료', quantity: 1, unit: 'g',
    reason: '유통기한', waste_date: '2026-01-01',
  });

  const res = await fetch(`${ctx.baseUrl}/api/waste/summary?store_id=${storeBId}`, { headers: authHeader(ownerToken) });
  assert.equal(res.status, 200);
  const rows = await res.json();
  assert.ok(rows.every(r => r.ingredient_name !== 'B매장폐기재료'), 'B매장 폐기 행이 섞여 나오면 안 된다');
});

test('POST /api/stock/adjustments — HQ_ACCOUNTING 403, HQ_LOGISTICS 200', async () => {
  const ingId = await createIngredient(brandId, storeAId, { stock: 100, threshold: 10 });
  const accounting = await createUser({ brand_id: brandId, role: 'HQ_ACCOUNTING' });
  const logistics = await createUser({ brand_id: brandId, role: 'HQ_LOGISTICS' });
  const accountingToken = tokenFor(accounting);
  const logisticsToken = tokenFor(logistics);

  const res1 = await fetch(`${ctx.baseUrl}/api/stock/adjustments`, {
    method: 'POST', headers: { ...authHeader(accountingToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeAId, ingredient_id: ingId, counted_stock: 90 }),
  });
  assert.equal(res1.status, 403);

  const res2 = await fetch(`${ctx.baseUrl}/api/stock/adjustments`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ store_id: storeAId, ingredient_id: ingId, counted_stock: 90 }),
  });
  assert.equal(res2.status, 200);
});

test('DELETE /api/waste/:id — HQ_ACCOUNTING 403', async () => {
  const [{ id: wasteId }] = await knex('waste_logs').insert({
    brand_id: brandId, store_id: storeAId, ingredient_name: '삭제대상재료', quantity: 1, unit: 'g',
    reason: '테스트', waste_date: '2026-01-01',
  }).returning('id');
  const accounting = await createUser({ brand_id: brandId, role: 'HQ_ACCOUNTING' });
  const token = tokenFor(accounting);

  const res = await fetch(`${ctx.baseUrl}/api/waste/${wasteId}`, { method: 'DELETE', headers: authHeader(token) });
  assert.equal(res.status, 403);
});

test('requireAuth는 매 요청마다 DB에서 role/store_id를 다시 읽는다 (토큰 발급 이후 DB 변경이 즉시 반영됨)', async () => {
  // STORE_OWNER로 토큰 발급 후 DB에서 역할을 HQ_ADMIN으로 바꾸면, 만료 전 이전 토큰으로도
  // HQ 전용 라우트를 통과해야 한다 — 토큰(최대 7일 유효)만 믿으면 강등/승격이 즉시 반영되지 않는다.
  const promoted = await createUser({ brand_id: brandId, store_id: storeAId, role: 'STORE_OWNER' });
  const promotedToken = tokenFor(promoted);
  await knex('users').where({ id: promoted.id }).update({ role: 'HQ_ADMIN', store_id: null });

  const res = await fetch(`${ctx.baseUrl}/api/store-rankings`, { headers: authHeader(promotedToken) });
  assert.equal(res.status, 200, '토큰이 예전 역할(STORE_OWNER)이어도 DB의 최신 역할(HQ_ADMIN)로 통과해야 한다');

  // 반대로 HQ 토큰 발급 후 DB를 STORE_OWNER + 다른 store_id로 바꾸면 403이 나고, 데이터도 그 매장으로만 제한되어야 한다.
  // 위쪽 테스트에서 이미 storeBId에 매출(99999원)을 넣어뒀으므로, 합산액과 헷갈리지 않도록 이 테스트
  // 전용 매장(storeC)을 새로 만들어 검증한다.
  const storeCId = await createStore(brandId, { name: 'C매장' });
  const demoted = await createUser({ brand_id: brandId, role: 'HQ_ADMIN' });
  const demotedToken = tokenFor(demoted);
  await knex('users').where({ id: demoted.id }).update({ role: 'STORE_OWNER', store_id: storeCId });

  const res2 = await fetch(`${ctx.baseUrl}/api/store-rankings`, { headers: authHeader(demotedToken) });
  assert.equal(res2.status, 403, 'DB에서 STORE_OWNER로 강등되면 HQ 전용 라우트가 막혀야 한다');

  await knex('orders').insert({
    brand_id: brandId, store_id: storeCId, toss_order_id: `order_demoted_${Date.now()}`,
    raw_payload: '{}', order_state: 'COMPLETED', total_amount: 55555, channel: 'POS',
    processed_at: new Date().toISOString(),
  });
  const res3 = await fetch(`${ctx.baseUrl}/api/dashboard/channel-breakdown?store_id=${storeAId}`, { headers: authHeader(demotedToken) });
  assert.equal(res3.status, 200);
  const body3 = await res3.json();
  const totalRevenue3 = body3.breakdown.reduce((s, r) => s + r.revenue, 0);
  assert.equal(totalRevenue3, 55555, '쿼리파라미터로 storeA를 지정해도 DB상 실제 소속(storeC) 데이터만 봐야 한다');
});

test('GET /api/orders/refund-reasons — STORE_OWNER 403, HQ_ACCOUNTING 200, 다른 브랜드 사유는 섞이지 않는다', async () => {
  const brandBId = await createBrand();
  const storeBOfBrandB = await createStore(brandBId, { name: 'B브랜드매장' });

  const [{ id: orderAId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeAId, status: 'CANCELED', total_amount: 1000,
  }).returning('id');
  await knex('order_history').insert({
    order_id: orderAId, action: 'REFUND', reason_code: 'OUT_OF_STOCK',
  });

  const [{ id: orderBId }] = await knex('purchase_orders').insert({
    brand_id: brandBId, store_id: storeBOfBrandB, status: 'CANCELED', total_amount: 1000,
  }).returning('id');
  await knex('order_history').insert({
    order_id: orderBId, action: 'REFUND', reason_code: 'DAMAGED',
  });

  const owner = await createUser({ brand_id: brandId, store_id: storeAId, role: 'STORE_OWNER' });
  const accounting = await createUser({ brand_id: brandId, role: 'HQ_ACCOUNTING' });
  const ownerToken = tokenFor(owner);
  const accountingToken = tokenFor(accounting);

  const res1 = await fetch(`${ctx.baseUrl}/api/orders/refund-reasons`, { headers: authHeader(ownerToken) });
  assert.equal(res1.status, 403);

  const res2 = await fetch(`${ctx.baseUrl}/api/orders/refund-reasons`, { headers: authHeader(accountingToken) });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.length, 1, '다른 브랜드(B)의 사유코드가 섞여 나오면 안 된다');
  assert.equal(body2[0].reason_code, 'OUT_OF_STOCK');
  assert.equal(body2[0].count, 1);
});

test('DELETE /api/orders/:id — HQ_ACCOUNTING 403, HQ_LOGISTICS 200, STORE_OWNER(자기 매장 DRAFT) 200', async () => {
  const accounting = await createUser({ brand_id: brandId, role: 'HQ_ACCOUNTING' });
  const logistics = await createUser({ brand_id: brandId, role: 'HQ_LOGISTICS' });
  const owner = await createUser({ brand_id: brandId, store_id: storeAId, role: 'STORE_OWNER' });
  const accountingToken = tokenFor(accounting);
  const logisticsToken = tokenFor(logistics);
  const ownerToken = tokenFor(owner);

  const [{ id: orderForAccounting }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeAId, status: 'DRAFT', total_amount: 1000,
  }).returning('id');
  const res1 = await fetch(`${ctx.baseUrl}/api/orders/${orderForAccounting}`, { method: 'DELETE', headers: authHeader(accountingToken) });
  assert.equal(res1.status, 403);

  const [{ id: orderForLogistics }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeAId, status: 'DRAFT', total_amount: 1000,
  }).returning('id');
  const res2 = await fetch(`${ctx.baseUrl}/api/orders/${orderForLogistics}`, { method: 'DELETE', headers: authHeader(logisticsToken) });
  assert.equal(res2.status, 200);

  const [{ id: orderForOwner }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeAId, status: 'DRAFT', total_amount: 1000,
  }).returning('id');
  const res3 = await fetch(`${ctx.baseUrl}/api/orders/${orderForOwner}`, { method: 'DELETE', headers: authHeader(ownerToken) });
  assert.equal(res3.status, 200);
});
