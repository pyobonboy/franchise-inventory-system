'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-stock-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createIngredient, createMenu, createRecipe,
  signWebhookHeaders,
} = require('./helpers');

let ctx;
let brandId;
let storeId;
const SECRET = 'whsec_stock_test_secret';

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

async function postWebhook(payload) {
  const rawBody = JSON.stringify(payload);
  const headers = signWebhookHeaders(SECRET, rawBody);
  return fetch(`${ctx.baseUrl}/webhook/${storeId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
}

function createdOrderPayload(orderId, lineItems) {
  return {
    type: 'order.order.created.v1',
    data: {
      order: {
        id: orderId,
        createdAt: new Date().toISOString(),
        lineItems,
      },
    },
  };
}

function cancelledOrderPayload(orderId) {
  return { type: 'order.order.cancelled.v1', data: { orderId } };
}

test('여러 줄 주문의 재고 차감 시 stock_ledger의 before/after가 끊기지 않고 이어지고, 마지막 after가 실제 재고와 일치한다', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '밀가루', stock: 1000, threshold: 100 });
  const menuAId = await createMenu(brandId, storeId, { name: '메뉴A' });
  const menuBId = await createMenu(brandId, storeId, { name: '메뉴B' });
  await createRecipe(menuAId, ingredientId, 2); // 메뉴A 1개당 밀가루 2 소모
  await createRecipe(menuBId, ingredientId, 3); // 메뉴B 1개당 밀가루 3 소모

  const orderId = `order_multiline_${Date.now()}`;
  const res = await postWebhook(createdOrderPayload(orderId, [
    { name: '메뉴A', quantity: 2 }, // 2 * 2 = 4 소모
    { name: '메뉴B', quantity: 1 }, // 3 * 1 = 3 소모
  ]));
  assert.equal(res.status, 200);

  const ingredient = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(ingredient.stock, 1000 - 4 - 3);

  const ledgerRows = await knex('stock_ledger')
    .where({ ingredient_id: ingredientId })
    .orderBy('id', 'asc');
  assert.equal(ledgerRows.length, 2);
  // 체인이 끊기지 않아야 한다: 이전 행의 after_stock === 다음 행의 before_stock
  for (let i = 1; i < ledgerRows.length; i++) {
    assert.equal(ledgerRows[i - 1].after_stock, ledgerRows[i].before_stock);
  }
  assert.equal(ledgerRows[0].before_stock, 1000);
  const lastRow = ledgerRows[ledgerRows.length - 1];
  assert.equal(lastRow.after_stock, ingredient.stock);
});

test('같은 주문 웹훅이 재전송되어도 재고가 이중 차감되지 않는다', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '설탕', stock: 500, threshold: 50 });
  const menuId = await createMenu(brandId, storeId, { name: '메뉴C' });
  await createRecipe(menuId, ingredientId, 5);

  const orderId = `order_resend_${Date.now()}`;
  const payload = createdOrderPayload(orderId, [{ name: '메뉴C', quantity: 2 }]); // 5*2=10 소모

  const res1 = await postWebhook(payload);
  assert.equal(res1.status, 200);
  const afterFirst = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterFirst.stock, 500 - 10);
  const ledgerCountAfterFirst = await knex('stock_ledger').where({ ingredient_id: ingredientId }).count('id as cnt').first();

  // 동일한 웹훅을 재전송 (실제 토스가 같은 이벤트를 중복 전송하는 상황을 재현)
  const res2 = await postWebhook(payload);
  assert.equal(res2.status, 200);

  const afterSecond = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterSecond.stock, afterFirst.stock, '재전송으로 재고가 추가로 깎이면 안 된다');
  const ledgerCountAfterSecond = await knex('stock_ledger').where({ ingredient_id: ingredientId }).count('id as cnt').first();
  assert.equal(Number(ledgerCountAfterSecond.cnt), Number(ledgerCountAfterFirst.cnt), '재전송으로 수불부가 추가로 쌓이면 안 된다');
});

test('주문 취소 시 재고 복구, orders.order_state=CANCELLED, sales_items 삭제가 모두 반영된다', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '치즈', stock: 300, threshold: 20 });
  const menuId = await createMenu(brandId, storeId, { name: '메뉴D' });
  await createRecipe(menuId, ingredientId, 4);

  const orderId = `order_cancel_${Date.now()}`;
  const created = await postWebhook(createdOrderPayload(orderId, [{ name: '메뉴D', quantity: 3 }])); // 4*3=12 소모
  assert.equal(created.status, 200);

  const afterCreate = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterCreate.stock, 300 - 12);
  const salesBefore = await knex('sales_items').where({ toss_order_id: orderId, store_id: storeId });
  assert.equal(salesBefore.length, 1);

  const cancelled = await postWebhook(cancelledOrderPayload(orderId));
  assert.equal(cancelled.status, 200);

  const afterCancel = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(afterCancel.stock, 300, '취소되면 재고가 원래대로 복구되어야 한다');

  const order = await knex('orders').where({ toss_order_id: orderId, store_id: storeId }).first();
  assert.equal(order.order_state, 'CANCELLED');

  const salesAfter = await knex('sales_items').where({ toss_order_id: orderId, store_id: storeId });
  assert.equal(salesAfter.length, 0, '취소되면 sales_items가 삭제되어야 한다');
});

test('트랜잭션 중간에 실패하면 재고와 주문이 모두 원상 복구된다 (롤백)', async () => {
  const ingredientId = await createIngredient(brandId, storeId, { name: '버터', stock: 700, threshold: 30 });
  const menuId = await createMenu(brandId, storeId, { name: '메뉴E' });
  await createRecipe(menuId, ingredientId, 6);

  const orderId = `order_rollback_${Date.now()}`;

  // stock_ledger 테이블을 일시적으로 rename해서, 트랜잭션의 마지막 단계(수불부 기록)에서
  // 실패가 나도록 강제한다 — orders/ingredients/sales_items는 이미 같은 트랜잭션 안에서
  // 갱신된 뒤이므로, 롤백이 실제로 동작하지 않으면 이 값들이 어긋난 채로 남는다.
  await knex.schema.renameTable('stock_ledger', 'stock_ledger_tmp_renamed');
  let res;
  try {
    res = await postWebhook(createdOrderPayload(orderId, [{ name: '메뉴E', quantity: 1 }]));
  } finally {
    await knex.schema.renameTable('stock_ledger_tmp_renamed', 'stock_ledger');
  }

  assert.equal(res.status, 500, '트랜잭션이 실패하면 500을 응답해야 한다');

  const ingredient = await knex('ingredients').where({ id: ingredientId }).first();
  assert.equal(ingredient.stock, 700, '롤백되면 재고가 그대로여야 한다');

  const order = await knex('orders').where({ toss_order_id: orderId, store_id: storeId }).first();
  assert.equal(order, undefined, '롤백되면 orders 행도 생성되지 않아야 한다');

  const sales = await knex('sales_items').where({ toss_order_id: orderId, store_id: storeId });
  assert.equal(sales.length, 0, '롤백되면 sales_items도 남지 않아야 한다');

  const ledgerRows = await knex('stock_ledger').where({ ingredient_id: ingredientId });
  assert.equal(ledgerRows.length, 0, '롤백되면 수불부에도 기록이 남지 않아야 한다');
});
