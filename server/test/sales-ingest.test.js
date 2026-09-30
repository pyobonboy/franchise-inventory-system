'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-salesingest-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createIngredient, createMenu, createRecipe,
  signWebhookHeaders,
} = require('./helpers');

// 이 파일은 salesIngest.js(웹훅/폴링 공용 판매 반영 로직)를 웹훅 HTTP 경로로 구동해 검증한다 —
// 기존 stock-transactions.test.js/webhook-menu-matching.test.js와 같은 방침(내부 함수 직접 호출 금지).
let ctx;
let brandId;
let storeId;
const SECRET = 'whsec_salesingest_test_secret';

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeId = await createStore(brandId, { webhook_secret: SECRET });
});

after(async () => {
  await ctx.close();
  await teardown();
});

// storeId/secret을 생략하면 module 상단의 공용 가맹점(storeId/SECRET)을 쓴다 — 기존 테스트는 그대로
// 동작하고, 새 테스트만 다른 가맹점으로 보낼 때 옵션으로 지정한다(webhook-menu-matching.test.js와 같은 방식).
async function postWebhook(payload, { storeId: targetStoreId = storeId, secret = SECRET } = {}) {
  const rawBody = JSON.stringify(payload);
  const headers = signWebhookHeaders(secret, rawBody);
  return fetch(`${ctx.baseUrl}/webhook/${targetStoreId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
}

function createdOrderPayload(orderId, lineItems) {
  return {
    type: 'order.order.created.v1',
    data: { order: { id: orderId, createdAt: new Date().toISOString(), lineItems } },
  };
}

function cancelledOrderPayload(orderId) {
  return { type: 'order.order.cancelled.v1', data: { orderId } };
}

test('COMPLETED → 취소 → 다시 COMPLETED 순으로 웹훅이 와도 CANCELLED 상태가 유지되고 재고가 다시 깎이지 않는다', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '반복재료', stock: 500, threshold: 10 });
  const menuId = await createMenu(brandId, storeId, { name: '반복메뉴' });
  await createRecipe(menuId, ingredientId, 5);

  const orderId = `order_repeat_${Date.now()}`;
  const payload = createdOrderPayload(orderId, [{ name: '반복메뉴', quantity: 2 }]); // 5*2=10 소모

  const res1 = await postWebhook(payload);
  assert.equal(res1.status, 200);
  const afterCreate = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterCreate.stock, 500 - 10);

  const res2 = await postWebhook(cancelledOrderPayload(orderId));
  assert.equal(res2.status, 200);
  const afterCancel = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterCancel.stock, 500, '취소로 재고가 복구되어야 한다');
  let order = await knex('orders').where({ toss_order_id: orderId, store_id: storeId }).first();
  assert.equal(order.order_state, 'CANCELLED');
  assert.equal(order.total_amount, 0);

  // 폴링이 같은 주문을 다시 COMPLETED로 보는 상황(재유입)을 웹훅으로 재현
  const res3 = await postWebhook(payload);
  assert.equal(res3.status, 200);
  const afterReplay = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterReplay.stock, 500, '이미 취소된 주문이 다시 COMPLETED로 와도 재고가 또 깎이면 안 된다');
  order = await knex('orders').where({ toss_order_id: orderId, store_id: storeId }).first();
  assert.equal(order.order_state, 'CANCELLED', 'CANCELLED 상태가 그대로 유지되어야 한다');
  assert.equal(order.total_amount, 0, '취소된 주문의 매출이 되살아나면 안 된다');
});

test('한 주문에 같은 메뉴가 2줄로 오면 sales_items는 1행으로 합산되고 재고는 2개분 차감된다', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '합산재료', stock: 1000, threshold: 10 });
  const menuId = await createMenu(brandId, storeId, { name: '합산메뉴' });
  await createRecipe(menuId, ingredientId, 3);

  const orderId = `order_merge_${Date.now()}`;
  const res = await postWebhook(createdOrderPayload(orderId, [
    { name: '합산메뉴', quantity: 1, price: 1000 },
    { name: '합산메뉴', quantity: 1, price: 1000 },
  ]));
  assert.equal(res.status, 200);

  const salesRows = await knex('sales_items').where({ toss_order_id: orderId, store_id: storeId });
  assert.equal(salesRows.length, 1, '같은 메뉴 두 줄은 sales_items 한 행으로 합산되어야 한다');
  assert.equal(salesRows[0].quantity, 2);
  assert.equal(salesRows[0].amount, 2000);

  const ingredient = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(ingredient.stock, 1000 - 3 * 2, '재고는 두 줄 모두(2개분) 차감되어야 한다');
});

test('재고부족 재료로 주문 4건이 연속으로 들어와도 alert_log는 1행만 쌓인다 (1시간 쿨다운)', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '쿨다운재료', stock: 1000, threshold: 9999 });
  const menuId = await createMenu(brandId, storeId, { name: '쿨다운메뉴' });
  await createRecipe(menuId, ingredientId, 1);

  for (let i = 0; i < 4; i++) {
    const orderId = `order_cooldown_${Date.now()}_${i}`;
    const res = await postWebhook(createdOrderPayload(orderId, [{ name: '쿨다운메뉴', quantity: 1 }]));
    assert.equal(res.status, 200);
  }

  const alerts = await knex('alert_log').where({ ingredient_id: ingredientId, store_id: storeId });
  assert.equal(alerts.length, 1, '1시간 쿨다운 안에서는 alert_log가 한 행만 쌓여야 한다');
});

// sqlite는 커넥션 풀이 1개뿐이라 두 요청의 트랜잭션이 실제로는 직렬화되지만(진짜 동시 경합은
// Postgres에서만 재현된다), ingestCompletedOrder/reverseCancelledOrder의 소유권 판정(조건부
// UPDATE rowcount)이 두 번째 요청을 올바르게 걸러내는지는 이 방식으로도 그대로 검증된다.
test('같은 COMPLETED 웹훅이 동시에 2건 들어와도 재고는 1회분만 차감되고 sales_items도 1세트만 생긴다', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '동시성재료', stock: 500, threshold: 10 });
  const menuId = await createMenu(brandId, storeId, { name: '동시성메뉴' });
  await createRecipe(menuId, ingredientId, 5);

  const orderId = `order_concurrent_${Date.now()}`;
  const payload = createdOrderPayload(orderId, [{ name: '동시성메뉴', quantity: 2 }]); // 5*2=10 소모

  const [res1, res2] = await Promise.all([postWebhook(payload), postWebhook(payload)]);
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  const ingredient = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(ingredient.stock, 500 - 10, '동시에 들어온 같은 주문이라도 재고는 1회분만 차감되어야 한다');

  const salesRows = await knex('sales_items').where({ toss_order_id: orderId, store_id: storeId });
  assert.equal(salesRows.length, 1, '동시 요청이라도 sales_items는 1세트만 생겨야 한다');

  const orders = await knex('orders').where({ toss_order_id: orderId, store_id: storeId });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].order_state, 'COMPLETED');
});

test('같은 취소 웹훅이 동시에 2건 들어와도 재고는 1회만 복구된다', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '동시취소재료', stock: 500, threshold: 10 });
  const menuId = await createMenu(brandId, storeId, { name: '동시취소메뉴' });
  await createRecipe(menuId, ingredientId, 5);

  const orderId = `order_concurrent_cancel_${Date.now()}`;
  const resCreate = await postWebhook(createdOrderPayload(orderId, [{ name: '동시취소메뉴', quantity: 2 }])); // 10 소모
  assert.equal(resCreate.status, 200);
  const afterCreate = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterCreate.stock, 500 - 10);

  const cancelPayload = cancelledOrderPayload(orderId);
  const [res1, res2] = await Promise.all([postWebhook(cancelPayload), postWebhook(cancelPayload)]);
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  const ingredient = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(ingredient.stock, 500, '동시 취소 요청이라도 재고는 1회만 복구되어야 한다');

  const order = await knex('orders').where({ toss_order_id: orderId, store_id: storeId }).first();
  assert.equal(order.order_state, 'CANCELLED');
});

test('가맹점 A·B에 같은 toss_order_id가 오면 A만 반영되고 B는 실패로 집계되며 A의 주문 원본이 덮어써지지 않는다', async () => {
  const secretA = 'whsec_dup_a';
  const secretB = 'whsec_dup_b';
  const storeAId = await createStore(brandId, { webhook_secret: secretA });
  const storeBId = await createStore(brandId, { webhook_secret: secretB });

  // B의 재료 재고가 실제로 안 건드려지는지 확인하기 위한 장치. ingestCompletedOrder는 소유권을
  // 못 얻으면 adjustStock까지 가지 않고 그 앞에서 throw하므로, 레시피가 있어도 차감되면 안 된다.
  const ingredientB = await createIngredient(brandId, storeBId, { name: 'B전용재료', stock: 300, threshold: 10 });
  const menuB = await createMenu(brandId, storeBId, { name: 'B메뉴' });
  await createRecipe(menuB, ingredientB, 7);

  const orderId = `dup_1_${Date.now()}`;
  const payloadA = createdOrderPayload(orderId, [{ name: 'A메뉴', quantity: 1, price: 1000 }]);
  const payloadB = createdOrderPayload(orderId, [{ name: 'B메뉴', quantity: 3, price: 2000 }]);

  const resA = await postWebhook(payloadA, { storeId: storeAId, secret: secretA });
  assert.equal(resA.status, 200);

  // orders.toss_order_id가 전역 UNIQUE라 B의 insert는 무시되고, store_id 조건이 있는 소유권 판정
  // UPDATE도 B에서는 대상 행을 못 찾는다 — salesIngest.js의 최종 throw 분기로 떨어져 웹훅 핸들러가
  // 500을 반환해야 한다(webhook.js의 바깥 try/catch).
  const resB = await postWebhook(payloadB, { storeId: storeBId, secret: secretB });
  assert.equal(resB.status, 500, '다른 가맹점이 같은 toss_order_id를 반영하려 하면 소유권 판정 실패로 500이어야 한다');

  const rows = await knex('orders').where({ toss_order_id: orderId });
  assert.equal(rows.length, 1, '같은 toss_order_id 행은 하나만 존재해야 한다');
  assert.equal(rows[0].store_id, storeAId, 'A가 먼저 반영한 주문 행의 소유권이 그대로 유지되어야 한다');
  const savedPayload = JSON.parse(rows[0].raw_payload);
  assert.equal(savedPayload.lineItems[0].name, 'A메뉴', 'B의 시도로 A의 주문 원본이 덮어써지면 안 된다');

  const ingredient = await knex('ingredients').where({ id: ingredientB }).first();
  assert.equal(ingredient.stock, 300, 'B의 반영이 실패했으니 B의 재료 재고는 변하지 않아야 한다');
});

// 위 dup 테스트는 A가 COMPLETED까지 완전히 끝난 뒤 B가 오는 경우만 재현한다 — 이 경우 336행의
// store_id 조건을 빼도 B의 선점 UPDATE 조건(order_state='INGESTING')이 애초에 안 맞아(A는 이미
// COMPLETED) 통과 여부가 갈리지 않는다(347행의 재조회 store_id만 이 경우를 잡아낸다). 진짜
// Postgres 동시 트랜잭션에서는 A가 INGESTING 행만 커밋해두고 아직 COMPLETED로 못 올린 순간에 B의
// 선점 UPDATE가 끼어들 수 있는데, sqlite는 트랜잭션 전체가 커넥션 1개로 직렬화돼(파일 상단 129행
// 주석 참고) Promise.all로는 그 창을 재현할 수 없다. 대신 그 순간의 상태(= INGESTING 행만 존재)를
// DB에 직접 만들어 336행의 store_id 조건 하나만 따로 검증한다.
test('A가 INGESTING으로 예약해둔 행을 B의 선점 UPDATE가 가로채면 안 된다 (다른 가맹점 행 오염 방지)', async () => {
  const secretA = 'whsec_ingesting_a';
  const secretB = 'whsec_ingesting_b';
  const storeAId = await createStore(brandId, { webhook_secret: secretA });
  const storeBId = await createStore(brandId, { webhook_secret: secretB });

  const orderId = `order_ingesting_race_${Date.now()}`;
  await knex('orders').insert({
    brand_id: brandId, store_id: storeAId, toss_order_id: orderId,
    raw_payload: JSON.stringify({ id: orderId, lineItems: [{ name: 'A메뉴', quantity: 1, price: 1000 }] }),
    processed_at: new Date().toISOString(), channel: 'POS', order_state: 'INGESTING',
  });

  const payloadB = createdOrderPayload(orderId, [{ name: 'B메뉴', quantity: 3, price: 2000 }]);
  const resB = await postWebhook(payloadB, { storeId: storeBId, secret: secretB });
  assert.equal(resB.status, 500, 'B의 선점 UPDATE가 A 소유의 INGESTING 행을 가로채면 안 되므로 소유권 판정 실패로 500이어야 한다');

  const row = await knex('orders').where({ toss_order_id: orderId }).first();
  assert.equal(row.store_id, storeAId, 'A 소유 행의 store_id가 그대로 유지되어야 한다');
  assert.equal(row.order_state, 'INGESTING', 'B가 가로채지 못했으니 A의 행은 여전히 INGESTING 상태여야 한다');
  const savedPayload = JSON.parse(row.raw_payload);
  assert.equal(savedPayload.lineItems[0].name, 'A메뉴', 'B의 페이로드로 A의 행 내용이 덮어써지면 안 된다');
});

test('취소된 주문이 COMPLETED로 재유입되면 SALES_REINGEST_BLOCKED 리스크가 1건 생성된다', async () => {
  // 다른 테스트(위 59행)와 같은 시나리오(생성→취소→재생성)를 재사용하되, 리스크 알림 dedup(브랜드,
  // 가맹점,타입) 단위 때문에 다른 테스트와 섞이지 않도록 이 테스트 전용 가맹점을 새로 만든다.
  const secret = 'whsec_reingest';
  const localStoreId = await createStore(brandId, { webhook_secret: secret });
  const ingredientId = await createIngredient(brandId, localStoreId, { name: '재유입재료', stock: 500, threshold: 10 });
  const menuId = await createMenu(brandId, localStoreId, { name: '재유입메뉴' });
  await createRecipe(menuId, ingredientId, 5);

  const orderId = `order_reingest_${Date.now()}`;
  const payload = createdOrderPayload(orderId, [{ name: '재유입메뉴', quantity: 2 }]);

  const res1 = await postWebhook(payload, { storeId: localStoreId, secret });
  assert.equal(res1.status, 200);
  const res2 = await postWebhook(cancelledOrderPayload(orderId), { storeId: localStoreId, secret });
  assert.equal(res2.status, 200);
  const res3 = await postWebhook(payload, { storeId: localStoreId, secret });
  assert.equal(res3.status, 200);

  const alerts = await knex('risk_alerts').where({ store_id: localStoreId, type: 'SALES_REINGEST_BLOCKED' });
  assert.equal(alerts.length, 1, '취소 후 재유입 시 SALES_REINGEST_BLOCKED 리스크가 정확히 1건 생성되어야 한다');
});

test('이미 COMPLETED이고 payload가 동일하면 주문 행을 다시 UPDATE하지 않는다', async () => {
  const secret = 'whsec_skip_update';
  const localStoreId = await createStore(brandId, { webhook_secret: secret });
  const ingredientId = await createIngredient(brandId, localStoreId, { name: '스킵재료', stock: 500, threshold: 10 });
  const menuId = await createMenu(brandId, localStoreId, { name: '스킵메뉴' });
  await createRecipe(menuId, ingredientId, 4);

  const orderId = `order_skip_${Date.now()}`;
  const payload = createdOrderPayload(orderId, [{ name: '스킵메뉴', quantity: 1 }]);

  const res1 = await postWebhook(payload, { storeId: localStoreId, secret });
  assert.equal(res1.status, 200);

  // 스킵 판정은 raw_payload/channel/processed_at 세 컬럼의 일치 여부로만 한다(salesIngest.js:362).
  // processed_at 자체를 표식으로 바꾸면 그 표식 값이 판정 조건에 그대로 들어가 "달라졌다"고 오판되어
  // 항상 갱신 분기를 타 버리므로, 판정에 쓰이지 않는 finance 필드(total_amount)를 표식으로 쓴다 —
  // 이 필드는 스킵되면 그대로 남고, 갱신되면(원 페이로드엔 chargePrice가 없어) 0으로 덮인다.
  const MARKER = 4242;
  await knex('orders').where({ toss_order_id: orderId, store_id: localStoreId }).update({ total_amount: MARKER });

  const res2 = await postWebhook(payload, { storeId: localStoreId, secret });
  assert.equal(res2.status, 200);
  let order = await knex('orders').where({ toss_order_id: orderId, store_id: localStoreId }).first();
  assert.equal(order.total_amount, MARKER, '변동 없는 재유입은 주문 행을 다시 UPDATE하면 안 된다(스킵되어야 한다)');

  // 라인아이템 가격을 바꿔 raw_payload 자체가 달라진 재유입을 보내면(스킵 조건 중 하나가 달라짐)
  // 실제로 갱신되어 표식값이 사라지는 것도 확인한다 — 스킵이 과도하게 걸리지 않음을 보장.
  const changedPayload = createdOrderPayload(orderId, [{ name: '스킵메뉴', quantity: 1, price: 9999 }]);
  const res3 = await postWebhook(changedPayload, { storeId: localStoreId, secret });
  assert.equal(res3.status, 200);
  order = await knex('orders').where({ toss_order_id: orderId, store_id: localStoreId }).first();
  assert.notEqual(order.total_amount, MARKER, 'payload 내용이 달라지면 주문 행이 갱신되어야 한다(스킵이 과하지 않음)');
});
