'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-orderstatusflow-${process.pid}-${Date.now()}.db`);
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
let storeToken;
let logisticsToken;
const originalFetch = global.fetch;

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeId = await createStore(brandId);
  const storeUser = await createUser({ brand_id: brandId, store_id: storeId, role: 'STORE_OWNER' });
  const logisticsUser = await createUser({ brand_id: brandId, role: 'HQ_LOGISTICS' });
  storeToken = tokenFor(storeUser);
  logisticsToken = tokenFor(logisticsUser);
});

after(async () => {
  global.fetch = originalFetch;
  await ctx.close();
  await teardown();
});

afterEach(() => { global.fetch = originalFetch; });

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

function mockToss(handler) {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith(TOSS_API_BASE)) return handler(url, opts);
    return originalFetch(url, opts);
  };
}

test('POST /api/orders/:id/status: REVIEWING → SHIPPED 400, REVIEWING → CONFIRMED 200, 임의 문자열 400', async () => {
  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'REVIEWING', total_amount: 1000,
  }).returning('id');

  const res1 = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'SHIPPED' }),
  });
  assert.equal(res1.status, 400);

  const res2 = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'BANANA' }),
  });
  assert.equal(res2.status, 400);

  const res3 = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CONFIRMED' }),
  });
  assert.equal(res3.status, 200);
});

test('POST /api/orders/:id/status: PAYMENT_PENDING → PAID는 400 (정상 결제는 payment/confirm이 직접 처리)', async () => {
  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PAYMENT_PENDING', total_amount: 1000,
  }).returning('id');

  const res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAID' }),
  });
  assert.equal(res.status, 400, '상태변경 API로는 PAYMENT_PENDING → PAID를 허용하면 안 된다');

  const order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.status, 'PAYMENT_PENDING');
});

test('DELETE /api/orders/:id: paid_at가 채워진 PREPARING_SHIPMENT는 400, paid_at 없는 PAYMENT_PENDING은 200', async () => {
  const [{ id: paidOrderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PREPARING_SHIPMENT', total_amount: 1000,
    paid_at: new Date().toISOString(),
  }).returning('id');
  const res1 = await fetch(`${ctx.baseUrl}/api/orders/${paidOrderId}`, { method: 'DELETE', headers: authHeader(storeToken) });
  assert.equal(res1.status, 400);

  const [{ id: pendingOrderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PAYMENT_PENDING', total_amount: 1000,
  }).returning('id');
  const res2 = await fetch(`${ctx.baseUrl}/api/orders/${pendingOrderId}`, { method: 'DELETE', headers: authHeader(storeToken) });
  assert.equal(res2.status, 200);
});

test('PUT /api/orders/:id/items/:itemId: 확정수량 검증 + 부분 필드만 보내도 이전 확정수량이 유지되고 amount가 갱신된다', async () => {
  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'ORDERED', total_amount: 10000,
  }).returning('id');
  const [{ id: itemId }] = await knex('purchase_order_items').insert({
    order_id: orderId, product_name: '품목A', unit: '개', unit_price: 1000, quantity: 10, amount: 10000,
  }).returning('id');

  let res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed_quantity: -3 }),
  });
  assert.equal(res.status, 400, '음수 확정수량은 400');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed_quantity: 11 }),
  });
  assert.equal(res.status, 400, '발주 수량(10)을 초과하는 확정수량은 400');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400, '빈 바디는 400');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed_quantity: 5 }),
  });
  assert.equal(res.status, 200);
  let item = await knex('purchase_order_items').where({ id: itemId }).first();
  assert.equal(item.confirmed_quantity, 5);
  assert.equal(item.amount, 1000 * 5, '확정수량 변경 시 amount가 함께 갱신되어야 한다');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ substitute_note: '대체 안내' }),
  });
  assert.equal(res.status, 200);
  item = await knex('purchase_order_items').where({ id: itemId }).first();
  assert.equal(item.confirmed_quantity, 5, 'substitute_note만 보내도 이전 확정수량(5)이 발주수량(10)으로 되돌아가면 안 된다');
  assert.equal(item.amount, 1000 * 5, 'amount도 유지된 확정수량 기준이어야 한다');
  assert.equal(item.substitute_note, '대체 안내');
});

test('POST /api/orders: 음수 단가를 섞은 라인은 서버 상품가로 덮어써져 total_amount가 정상값이 되고, product_id 없는 라인은 400', async () => {
  const [{ id: productId }] = await knex('products').insert({
    brand_id: brandId, name: '주문생성상품', unit: '박스', unit_conversion: 1, base_unit: '개', price: 5000, is_active: true,
  }).returning('id');

  const res1 = await fetch(`${ctx.baseUrl}/api/orders`, {
    method: 'POST', headers: { ...authHeader(storeToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ submit: false, items: [{ product_id: productId, product_name: '주문생성상품', quantity: 2, unit_price: -100000 }] }),
  });
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  const order = await knex('purchase_orders').where({ id: body1.id }).first();
  assert.equal(order.total_amount, 5000 * 2, '클라이언트가 보낸 음수 단가는 무시되고 서버 상품가로 계산되어야 한다');

  const res2 = await fetch(`${ctx.baseUrl}/api/orders`, {
    method: 'POST', headers: { ...authHeader(storeToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ submit: false, items: [{ product_name: '무등록상품', quantity: 1, unit_price: 1000 }] }),
  });
  assert.equal(res2.status, 400, 'product_id가 없는 라인은 400이어야 한다');
});

test('납품 시 환불수량 차감: 10개 발주 → 결제 → 4개 품목환불 → DELIVERED → 재고 증가분이 6 × unit_conversion', async () => {
  const ingId = await createIngredient(brandId, storeId, { name: '납품재고재료', stock: 100, threshold: 0 });
  const [{ id: productId }] = await knex('products').insert({
    brand_id: brandId, ingredient_id: ingId, name: '납품상품', unit: '박스', unit_conversion: 2, base_unit: 'g', price: 1000, is_active: true,
  }).returning('id');

  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PAID', total_amount: 10000, confirmed_amount: 10000,
    paid_at: new Date().toISOString(), toss_payment_key: 'pk_delivery_refund_test', refunded_amount: 0, stock_applied: false,
  }).returning('id');
  const [{ id: itemId }] = await knex('purchase_order_items').insert({
    order_id: orderId, product_id: productId, product_name: '납품상품', unit: '박스',
    unit_price: 1000, quantity: 10, confirmed_quantity: 10, amount: 10000, refunded_quantity: 0,
  }).returning('id');
  await knex('payments').insert({ order_id: orderId, payment_key: 'pk_delivery_refund_test', status: 'PAID', amount: 10000 });

  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 4000 }) }));
  const refundRes = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '품절', items: [{ item_id: itemId, quantity: 4 }] }),
  });
  assert.equal(refundRes.status, 200);

  // PAID → SHIPPED → DELIVERED (PAID에서 DELIVERED로 바로 가는 전이는 허용되지 않는다)
  let res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'SHIPPED' }),
  });
  assert.equal(res.status, 200);
  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'DELIVERED' }),
  });
  assert.equal(res.status, 200);

  const ingredient = await knex('ingredients').where({ id: ingId }).first();
  assert.equal(ingredient.stock, 100 + 6 * 2, '환불된 4개를 뺀 6개분만 unit_conversion(2)을 곱해 재고가 늘어야 한다');
});

test('PUT /api/orders/:id: REVISION_REQUESTED 재제출 시 confirmed_amount가 초기화되어 결제 금액이 새 총액과 일치한다', async () => {
  const [{ id: productId }] = await knex('products').insert({
    brand_id: brandId, name: '재제출상품', unit: '개', unit_conversion: 1, base_unit: '개', price: 1000, is_active: true,
  }).returning('id');
  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'ORDERED', total_amount: 10000,
  }).returning('id');
  const [{ id: itemId }] = await knex('purchase_order_items').insert({
    order_id: orderId, product_id: productId, product_name: '재제출상품', unit: '개', unit_price: 1000, quantity: 10, amount: 10000,
  }).returning('id');

  let res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed_quantity: 5 }),
  });
  assert.equal(res.status, 200);
  let order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.confirmed_amount, 5000, 'confirmed_quantity 5 확정 시 confirmed_amount는 5000이어야 한다');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'REVISION_REQUESTED' }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}`, {
    method: 'PUT', headers: { ...authHeader(storeToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ submit: true, items: [{ product_id: productId, product_name: '재제출상품', quantity: 20, unit_price: 1000 }] }),
  });
  assert.equal(res.status, 200);

  order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(order.confirmed_amount, null, '재제출 후 confirmed_amount는 초기화되어야 한다');
  assert.equal(order.total_amount, 20000);

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CONFIRMED' }),
  });
  assert.equal(res.status, 200);

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/payment/prepare`, {
    method: 'POST', headers: { ...authHeader(storeToken), 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const prepareBody = await res.json();
  assert.equal(prepareBody.amount, 20000, '결제 금액은 재제출된 새 총액과 일치해야 한다');
});

test('PUT items: status만 OUT_OF_STOCK으로 보내면 confirmed_quantity=0, 그 품목 amount=0, confirmed_amount에서 제외된다', async () => {
  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'ORDERED', total_amount: 30000,
  }).returning('id');
  const [{ id: itemAId }] = await knex('purchase_order_items').insert({
    order_id: orderId, product_name: '품목A', unit: '개', unit_price: 1000, quantity: 10, amount: 10000,
  }).returning('id');
  await knex('purchase_order_items').insert({
    order_id: orderId, product_name: '품목B', unit: '개', unit_price: 2000, quantity: 10, amount: 20000,
  });

  let res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemAId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'OUT_OF_STOCK' }),
  });
  assert.equal(res.status, 200);
  let itemA = await knex('purchase_order_items').where({ id: itemAId }).first();
  let order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(itemA.confirmed_quantity, 0, '품절 처리 시 확정수량은 0이어야 한다');
  assert.equal(itemA.amount, 0, '품절 품목의 금액은 0이어야 한다');
  assert.equal(order.confirmed_amount, 20000, '품절 품목은 확정금액에서 제외되어야 한다');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/items/${itemAId}`, {
    method: 'PUT', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'NORMAL' }),
  });
  assert.equal(res.status, 200);
  itemA = await knex('purchase_order_items').where({ id: itemAId }).first();
  order = await knex('purchase_orders').where({ id: orderId }).first();
  assert.equal(itemA.confirmed_quantity, null, '품절 해제 시 확정수량은 조정 없음(null)으로 복원되어야 한다');
  assert.equal(itemA.amount, 10000, '품절 해제 후 금액은 원 발주수량 기준으로 복원되어야 한다');
  assert.equal(order.confirmed_amount, 30000);
});

test('결제 완료 발주서는 상태변경으로도 삭제로도 취소되지 않는다', async () => {
  const paidAt = new Date().toISOString();
  const [{ id: paidOrderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PAID', total_amount: 10000,
    paid_at: paidAt, refunded_amount: 0,
  }).returning('id');

  let res = await fetch(`${ctx.baseUrl}/api/orders/${paidOrderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CANCELED' }),
  });
  assert.equal(res.status, 400, 'PAID 상태에서 상태변경으로 CANCELED는 400이어야 한다');

  res = await fetch(`${ctx.baseUrl}/api/orders/${paidOrderId}`, {
    method: 'DELETE', headers: authHeader(storeToken),
  });
  assert.equal(res.status, 400, '결제 완료된 발주서는 삭제(취소)할 수 없다');

  const order = await knex('purchase_orders').where({ id: paidOrderId }).first();
  assert.equal(order.status, 'PAID');
  assert.equal(new Date(order.paid_at).getTime(), new Date(paidAt).getTime());
  assert.equal(order.refunded_amount, 0);

  const [{ id: deliveredOrderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'DELIVERED', total_amount: 10000,
    paid_at: paidAt,
  }).returning('id');
  res = await fetch(`${ctx.baseUrl}/api/orders/${deliveredOrderId}/status`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CANCELED' }),
  });
  assert.equal(res.status, 400, 'DELIVERED 상태에서도 CANCELED 변경은 400이어야 한다');
});

test('refund-items: 같은 item_id를 두 번 보내면 합산되어 검증된다', async () => {
  const [{ id: productId }] = await knex('products').insert({
    brand_id: brandId, name: '중복품목상품', unit: '개', unit_conversion: 1, base_unit: 'g', price: 1000, is_active: true,
  }).returning('id');
  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PAID', total_amount: 10000, confirmed_amount: 10000,
    paid_at: new Date().toISOString(), toss_payment_key: 'pk_dup_item_test', refunded_amount: 0, stock_applied: false,
  }).returning('id');
  const [{ id: itemId }] = await knex('purchase_order_items').insert({
    order_id: orderId, product_id: productId, product_name: '중복품목상품', unit: '개',
    unit_price: 1000, quantity: 10, confirmed_quantity: 10, amount: 10000, refunded_quantity: 0,
  }).returning('id');
  await knex('payments').insert({ order_id: orderId, payment_key: 'pk_dup_item_test', status: 'PAID', amount: 10000 });

  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 10000 }) }));

  let res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '중복테스트', items: [{ item_id: itemId, quantity: 10 }, { item_id: itemId, quantity: 10 }] }),
  });
  assert.equal(res.status, 400, '합산 수량(20)이 발주 수량(10)을 초과하면 400이어야 한다');

  let order = await knex('purchase_orders').where({ id: orderId }).first();
  let item = await knex('purchase_order_items').where({ id: itemId }).first();
  assert.equal(order.refunded_amount, 0, '검증 실패 시 refunded_amount는 변하면 안 된다');
  assert.equal(item.refunded_quantity, 0, '검증 실패 시 refunded_quantity는 변하면 안 된다');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '분할환불', items: [{ item_id: itemId, quantity: 4 }, { item_id: itemId, quantity: 6 }] }),
  });
  assert.equal(res.status, 200);
  item = await knex('purchase_order_items').where({ id: itemId }).first();
  assert.equal(item.refunded_quantity, 10, '합산된 수량(10)만 반영되어야 한다(20이 아님)');
});

test('/refund 부분환불 후 /refund-items로 나머지를 채우면 요청에 없던 품목의 재고도 원복된다', async () => {
  const dIngId = await createIngredient(brandId, storeId, { name: '부분환불D재료', stock: 10, threshold: 0 });
  const [{ id: productCId }] = await knex('products').insert({
    brand_id: brandId, name: '부분환불C상품', unit: '개', unit_conversion: 1, base_unit: 'g', price: 1000, is_active: true,
  }).returning('id');
  const [{ id: productDId }] = await knex('products').insert({
    brand_id: brandId, ingredient_id: dIngId, name: '부분환불D상품', unit: '개', unit_conversion: 1, base_unit: 'g', price: 1000, is_active: true,
  }).returning('id');

  const [{ id: orderId }] = await knex('purchase_orders').insert({
    brand_id: brandId, store_id: storeId, status: 'PAID', total_amount: 20000, confirmed_amount: 20000,
    paid_at: new Date().toISOString(), toss_payment_key: 'pk_partial_then_full', refunded_amount: 0, stock_applied: true, stock_reversed: false,
  }).returning('id');
  const [{ id: itemCId }] = await knex('purchase_order_items').insert({
    order_id: orderId, product_id: productCId, product_name: '부분환불C상품', unit: '개',
    unit_price: 1000, quantity: 10, confirmed_quantity: 10, amount: 10000, refunded_quantity: 0,
  }).returning('id');
  const [{ id: itemDId }] = await knex('purchase_order_items').insert({
    order_id: orderId, product_id: productDId, product_name: '부분환불D상품', unit: '개',
    unit_price: 1000, quantity: 10, confirmed_quantity: 10, amount: 10000, refunded_quantity: 0,
  }).returning('id');
  await knex('payments').insert({ order_id: orderId, payment_key: 'pk_partial_then_full', status: 'PAID', amount: 20000 });

  mockToss(async () => ({ ok: true, status: 200, json: async () => ({ cancelAmount: 10000 }) }));

  let res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '부분환불', amount: 10000 }),
  });
  assert.equal(res.status, 200, '부분환불(10000원)은 성공해야 한다');

  res = await fetch(`${ctx.baseUrl}/api/orders/${orderId}/refund-items`, {
    method: 'POST', headers: { ...authHeader(logisticsToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '나머지환불', items: [{ item_id: itemCId, quantity: 10 }] }),
  });
  assert.equal(res.status, 200, 'C 10개 환불로 잔액이 소진되어 전액환불이 성립해야 한다');

  const itemC = await knex('purchase_order_items').where({ id: itemCId }).first();
  const itemD = await knex('purchase_order_items').where({ id: itemDId }).first();
  const order = await knex('purchase_orders').where({ id: orderId }).first();
  const dIngredient = await knex('ingredients').where({ id: dIngId }).first();

  assert.equal(itemC.refunded_quantity, 10);
  assert.equal(itemD.refunded_quantity, 10, '요청에 없던 D 품목도 전액환불 성립 시 채워져야 한다');
  assert.equal(dIngredient.stock, 0, 'D의 재료 재고가 0으로 원복되어야 한다');
  assert.ok(order.stock_reversed, 'stock_reversed는 true여야 한다');
});
