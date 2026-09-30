'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-refund-concurrency-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
// orders.js가 require 시점에 읽는 값이라 createApp() 호출(라우터 require) 전에 설정해야 한다.
process.env.TOSS_SECRET_KEY = 'test_sk_dummy_key';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createUser, tokenFor, createIngredient,
} = require('./helpers');

const TOSS_API_BASE = 'https://api.tosspayments.com/v1/payments';

let ctx;
let brandId;
let storeId;
let hqToken;
const originalFetch = global.fetch;

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeId = await createStore(brandId);
  const hqUser = await createUser({ brand_id: brandId, role: 'HQ_ADMIN' });
  hqToken = tokenFor(hqUser);
});

after(async () => {
  global.fetch = originalFetch;
  await ctx.close();
  await teardown();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// payments.test.js와 동일한 패턴 — global.fetch를 서버(ctx.baseUrl)와 토스 API가 공유하므로
// URL로 구분해 토스 호출만 가로챈다.
function mockToss(handler) {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(TOSS_API_BASE)) return handler(url, opts);
    return originalFetch(url, opts);
  };
}

// payment/prepare·confirm 플로우를 타지 않고 결제완료 상태(PAID + toss_payment_key + payments 행)를
// 직접 만든다 — 환불 트랜잭션 실패만 재현하면 되므로 결제승인 자체는 관심사가 아니다.
async function createPaidOrder(amount, paymentKey, overrides = {}) {
  const [row] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PAID',
    total_amount: amount, confirmed_amount: amount,
    toss_payment_key: paymentKey, paid_at: new Date().toISOString(),
    ...overrides,
  }).returning('id');
  const orderId = row.id ?? row;
  await knex('payments').insert({
    order_id: orderId, payment_key: paymentKey, status: 'PAID', amount,
    method: '카드', raw_response: '{}', paid_at: new Date().toISOString(),
  });
  return orderId;
}

async function createOrderItem(orderId, overrides = {}) {
  const [row] = await knex('purchase_order_items').insert({
    order_id: orderId, product_name: '테스트상품', unit: '개',
    unit_price: 1000, quantity: 5, confirmed_quantity: 5, amount: 5000,
    ...overrides,
  }).returning('id');
  return row.id ?? row;
}

// applyItemStock이 product_id → ingredient_id 경로로 재고를 찾도록, 재료에 연결된 발주 상품을 만든다.
async function createProduct(ingredientId, overrides = {}) {
  const [row] = await knex('products').insert({
    brand_id: brandId, ingredient_id: ingredientId, name: `상품_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    unit: '개', base_unit: '개', unit_conversion: 1, price: 1000,
    ...overrides,
  }).returning('id');
  return row.id ?? row;
}

test('토스 취소는 성공했는데 DB 반영 트랜잭션이 실패하면 500 + REFUND_INCONSISTENT 리스크가 남는다 (/refund)', async () => {
  const orderId = await createPaidOrder(10000, 'pk_test_refund_fail_1');

  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 4000 }) }));

  // payments 테이블을 잠시 rename해서, 환불 트랜잭션 안 trx('payments').update(...)가 throw하도록 강제한다
  // (stock-transactions.test.js의 rename 기법 참고).
  await knex.schema.renameTable('payments', 'payments_tmp_renamed');
  let res;
  try {
    res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '부분 반품', amount: 4000 }),
    });
  } finally {
    await knex.schema.renameTable('payments_tmp_renamed', 'payments');
  }

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.inconsistent, true);
  assert.match(body.error, /토스 환불은 완료/);
  assert.equal(body.refunded_amount, 4000);

  const risks = await knex('risk_alerts').where({ brand_id: brandId, store_id: storeId, type: 'REFUND_INCONSISTENT' });
  assert.equal(risks.length, 1);

  // 선점(claimRefundAmount)은 이미 토스 취소가 나간 뒤이므로 되돌리지 않는다 — 이중 환불 방지
  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 4000);
});

test('토스 취소는 성공했는데 DB 반영 트랜잭션이 실패하면 500 + REFUND_INCONSISTENT 리스크가 남는다 (/refund-items)', async () => {
  const orderId = await createPaidOrder(5000, 'pk_test_refund_fail_2');
  const itemId = await createOrderItem(orderId, { unit_price: 1000, quantity: 5, confirmed_quantity: 5, amount: 5000 });

  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 2000 }) }));

  await knex.schema.renameTable('payments', 'payments_tmp_renamed');
  let res;
  try {
    res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '품목 반품', items: [{ item_id: itemId, quantity: 2 }] }),
    });
  } finally {
    await knex.schema.renameTable('payments_tmp_renamed', 'payments');
  }

  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.inconsistent, true);
  assert.match(body.error, /토스 환불은 완료/);
  assert.equal(body.refunded_amount, 2000);

  const risks = await knex('risk_alerts').where({ brand_id: brandId, store_id: storeId, type: 'REFUND_INCONSISTENT' });
  assert.equal(risks.length, 1);

  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 2000);
});

test('/refund 동시 2건 발사 시 토스 취소는 1회만 나가고 refunded_amount/재고 원복도 1회만 반영된다', async () => {
  const amount = 10000;
  // stock:1000은 "이미 납품 반영(DELIVERED, stock_applied)까지 끝난 뒤"의 상태를 흉내낸 값이다 —
  // 환불(sign=-1)은 납품 반영분을 되돌리는 것이므로 재고를 그만큼 줄인다.
  const ingredientId = await createIngredient(brandId, storeId, { stock: 1000 });
  const productId = await createProduct(ingredientId);
  const orderId = await createPaidOrder(amount, 'pk_test_concurrent_refund_1', { status: 'DELIVERED', stock_applied: true });
  await createOrderItem(orderId, { product_id: productId, unit_price: 2000, quantity: 5, confirmed_quantity: 5, amount });

  let tossCalls = 0;
  mockToss(async () => { tossCalls += 1; return { ok: true, status: 200, json: async () => ({ cancelAmount: amount }) }; });

  const fire = () => fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '동시 환불 테스트', amount }),
  });

  const [res1, res2] = await Promise.all([fire(), fire()]);
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(tossCalls, 1, '토스 취소 API는 1회만 호출되어야 한다');

  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, amount, 'refunded_amount는 1회분만 반영되어야 한다');
  assert.equal(order.status, 'CANCELED');

  const ingredient = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(ingredient.stock, 995, '재고 원복은 1회만(5개분) 반영되어야 한다');
});

test('/refund-items 동시 2건 발사 시 토스 취소는 1회만 나가고 refunded_amount/재고 원복도 1회만 반영된다', async () => {
  const amount = 10000;
  const ingredientId = await createIngredient(brandId, storeId, { stock: 1000 });
  const productId = await createProduct(ingredientId);
  const orderId = await createPaidOrder(amount, 'pk_test_concurrent_refund_items_1', { status: 'DELIVERED', stock_applied: true });
  const itemId = await createOrderItem(orderId, { product_id: productId, unit_price: 2000, quantity: 5, confirmed_quantity: 5, amount });

  let tossCalls = 0;
  mockToss(async () => { tossCalls += 1; return { ok: true, status: 200, json: async () => ({ cancelAmount: amount }) }; });

  const fire = () => fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '동시 품목환불 테스트', items: [{ item_id: itemId, quantity: 5 }] }),
  });

  const [res1, res2] = await Promise.all([fire(), fire()]);
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(tossCalls, 1, '토스 취소 API는 1회만 호출되어야 한다');

  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, amount, 'refunded_amount는 1회분만 반영되어야 한다');
  assert.equal(order.status, 'CANCELED');

  const ingredient = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(ingredient.stock, 995, '재고 원복은 1회만(5개분) 반영되어야 한다');
});

test('토스가 ok:false(400)를 반환하면 refunded_amount가 호출 전 값으로 원복된다 (/refund)', async () => {
  const orderId = await createPaidOrder(10000, 'pk_test_toss_reject_1');

  mockToss(async () => ({ ok: false, status: 400, json: async () => ({ message: '카드사 거절', code: 'REJECT_CARD_COMPANY' }) }));

  const res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '거절 테스트', amount: 4000 }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'REJECT_CARD_COMPANY');

  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 0, '선점이 호출 전 값(0)으로 원복되어야 한다');
});

test('토스 호출이 네트워크 오류로 throw되면 502를 반환하고 refunded_amount가 원복되며 이후 재시도가 성공한다 (/refund)', async () => {
  const orderId = await createPaidOrder(10000, 'pk_test_network_fail_1');

  mockToss(() => Promise.reject(new Error('ECONNRESET')));
  const failRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '네트워크 오류 테스트', amount: 4000 }),
  });
  assert.equal(failRes.status, 502);

  let order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 0, '실패 시 선점이 원복되어야 한다');

  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 4000 }) }));
  const retryRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '재시도', amount: 4000 }),
  });
  assert.equal(retryRes.status, 200, '원복 이후 재시도는 정상적으로 성공해야 한다');

  order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 4000);
});

test('토스 호출이 네트워크 오류로 throw되면 502를 반환하고 refunded_amount가 원복되며 이후 재시도가 성공한다 (/refund-items)', async () => {
  const orderId = await createPaidOrder(5000, 'pk_test_network_fail_2');
  const itemId = await createOrderItem(orderId, { unit_price: 1000, quantity: 5, confirmed_quantity: 5, amount: 5000 });

  mockToss(() => Promise.reject(new Error('ECONNRESET')));
  const failRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '네트워크 오류 테스트', items: [{ item_id: itemId, quantity: 2 }] }),
  });
  assert.equal(failRes.status, 502);

  let order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 0, '실패 시 선점이 원복되어야 한다');

  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 2000 }) }));
  const retryRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '재시도', items: [{ item_id: itemId, quantity: 2 }] }),
  });
  assert.equal(retryRes.status, 200, '원복 이후 재시도는 정상적으로 성공해야 한다');

  order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 2000);
});

test('토스가 ok:false(400)를 반환하면 refunded_amount가 호출 전 값으로 원복된다 (/refund-items)', async () => {
  const orderId = await createPaidOrder(5000, 'pk_test_toss_reject_2');
  const itemId = await createOrderItem(orderId, { unit_price: 1000, quantity: 5, confirmed_quantity: 5, amount: 5000 });

  mockToss(async () => ({ ok: false, status: 400, json: async () => ({ message: '카드사 거절', code: 'REJECT_CARD_COMPANY' }) }));

  const res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hqToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '거절 테스트', items: [{ item_id: itemId, quantity: 2 }] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'REJECT_CARD_COMPANY');

  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.refunded_amount, 0, '선점이 호출 전 값(0)으로 원복되어야 한다');
});
