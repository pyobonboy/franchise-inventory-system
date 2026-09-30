'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-payments-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
// orders.js가 require 시점에 읽는 값이라 createApp() 호출(라우터 require) 전에 설정해야 한다.
process.env.TOSS_SECRET_KEY = 'test_sk_dummy_key';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createUser, tokenFor,
} = require('./helpers');

const TOSS_API_BASE = 'https://api.tosspayments.com/v1/payments';

let ctx;
let brandId;
let storeId;
let hqToken;
let storeToken;
const originalFetch = global.fetch;

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeId = await createStore(brandId);
  const hqUser = await createUser({ brand_id: brandId, role: 'HQ_ADMIN' });
  const storeUser = await createUser({ brand_id: brandId, store_id: storeId, role: 'STORE_OWNER' });
  hqToken = tokenFor(hqUser);
  storeToken = tokenFor(storeUser);
});

after(async () => {
  global.fetch = originalFetch;
  await ctx.close();
  await teardown();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// 우리 테스트 서버(ctx.baseUrl)로 가는 요청은 실제 fetch로 그대로 보내고, 토스 API로 가는 요청만
// 가로채서 모킹한다 — global.fetch 하나를 양쪽(테스트 클라이언트 호출 + 서버 내부의 토스 호출)이
// 공유하기 때문에 URL로 구분해야 한다.
function mockToss(handler) {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(TOSS_API_BASE)) return handler(url, opts);
    return originalFetch(url, opts);
  };
}

async function createConfirmedOrder(amount) {
  const [row] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'CONFIRMED',
    total_amount: amount, confirmed_amount: amount,
  }).returning('id');
  return row.id ?? row;
}

async function preparePayment(orderId) {
  const res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/payment/prepare`, {
    method: 'POST', headers: { Authorization: `Bearer ${storeToken}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('결제 승인 후 payments 테이블에 method/status=PAID/raw_response가 채워진다', async () => {
  const orderId = await createConfirmedOrder(15000);
  const prep = await preparePayment(orderId);

  mockToss(async () => ({
    ok: true, status: 200,
    json: async () => ({ method: '카드', totalAmount: 15000, approvedAt: new Date().toISOString() }),
  }));

  const confirmRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/payment/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${storeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey: 'pk_test_paid_1', orderId: prep.orderId, amount: prep.amount }),
  });
  assert.equal(confirmRes.status, 200);

  const payment = await knex('payments').where({ order_id: orderId }).first();
  assert.ok(payment, 'payments 행이 생성되어야 한다');
  assert.equal(payment.method, '카드');
  assert.equal(payment.status, 'PAID');
  assert.ok(payment.raw_response, 'raw_response가 채워져야 한다');
  assert.equal(JSON.parse(payment.raw_response).method, '카드');

  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.status, 'PAID');
});

test('결제 승인 금액이 서버 계산 금액과 다르면 거부되고 토스 API를 호출하지 않는다 (금액 조작 방어)', async () => {
  const orderId = await createConfirmedOrder(20000);
  const prep = await preparePayment(orderId);

  let tossCalled = false;
  mockToss(async () => { tossCalled = true; return { ok: true, status: 200, json: async () => ({}) }; });

  const confirmRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/payment/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${storeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey: 'pk_test_tamper', orderId: prep.orderId, amount: 1 }), // 조작된 금액
  });
  assert.equal(confirmRes.status, 400);
  const body = await confirmRes.json();
  assert.match(body.error, /금액/);
  assert.equal(tossCalled, false, '금액이 다르면 토스 API 호출 전에 거부해야 한다');

  const payment = await knex('payments').where({ order_id: orderId }).first();
  assert.equal(payment, undefined);
});

test('부분 환불은 PARTIALLY_REFUNDED, 전액 환불은 REFUNDED로 반영된다', async () => {
  const orderId = await createConfirmedOrder(10000);
  const prep = await preparePayment(orderId);

  mockToss(async () => ({
    ok: true, status: 200,
    json: async () => ({ method: '카드', totalAmount: 10000, approvedAt: new Date().toISOString() }),
  }));
  const confirmRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/payment/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${storeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey: 'pk_test_refund', orderId: prep.orderId, amount: prep.amount }),
  });
  assert.equal(confirmRes.status, 200);

  // 부분 환불 (4000원)
  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 4000 }) }));
  const partial = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '부분 반품', amount: 4000 }),
  });
  assert.equal(partial.status, 200);

  let payment = await knex('payments').where({ order_id: orderId }).first();
  assert.equal(payment.status, 'PARTIALLY_REFUNDED');
  let order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.status, 'PAID', '전액 환불 전에는 주문 상태가 유지되어야 한다');
  assert.equal(order.refunded_amount, 4000);

  // 나머지 전액 환불 (6000원)
  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 6000 }) }));
  const full = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '나머지 반품' }),
  });
  assert.equal(full.status, 200);

  payment = await knex('payments').where({ order_id: orderId }).first();
  assert.equal(payment.status, 'REFUNDED');
  order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.status, 'CANCELED');
  assert.equal(order.refunded_amount, 10000);
});
