'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-menumatch-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
// 전역 폴백 시크릿이 "시크릿 없는 가맹점" 테스트에 영향을 주지 않도록 명시적으로 비운다(webhook.test.js와 동일한 이유).
delete process.env.TOSS_WEBHOOK_SECRET;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createIngredient, createMenu, createRecipe,
  signWebhookHeaders,
} = require('./helpers');

// 이 파일은 사입 감시(가맹점이 본사 대신 다른 곳에서 재료를 사는지 감지)의 뼈대인 "메뉴 ID 매칭",
// "메뉴 자동 발견", "조용한 실패 감지(risk_alerts)"를 실제 웹훅 라우터에 HTTP 요청을 보내는 방식으로
// 검증한다. 내부 함수(adjustStock 등)를 직접 부르지 않는 이유: 이 파일이 지켜야 하는 건 "핸들러가
// 실제로 어떻게 반응하는가"이지 내부 구현이 아니라서, 나중에 adjustStock 내부를 리팩터해도 이
// 테스트들이 계속 유효해야 한다(기존 webhook.test.js/stock-transactions.test.js와 같은 방침).
let ctx;
let brandId;
const SECRET = 'whsec_menumatch_test_secret';

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
});

after(async () => {
  await ctx.close();
  await teardown();
});

async function newStore(overrides = {}) {
  return createStore(brandId, { webhook_secret: SECRET, ...overrides });
}

async function postWebhook(storeId, payload, { secret = SECRET, headers: extraHeaders = null, raw = null } = {}) {
  const rawBody = raw != null ? raw : JSON.stringify(payload);
  const headers = extraHeaders || (secret ? signWebhookHeaders(secret, rawBody) : {});
  return fetch(`${ctx.baseUrl}/webhook/${storeId}`, {
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

async function riskAlertsFor(storeId, type) {
  return knex('risk_alerts').where({ store_id: storeId, type });
}

// ── 1. 메뉴 ID 매칭으로 이름 변경 회피가 막히는가 ──────────────────────────

test('메뉴 이름이 바뀌어도 토스 메뉴 ID로 매칭되어 재고가 차감된다 (사입 감시 핵심)', async () => {
  const storeId = await newStore();
  const ingId = await createIngredient(brandId, storeId, { name: '아메리카노_원두', stock: 1000, threshold: 10 });
  const menuId = await createMenu(brandId, storeId, { name: '아메리카노', toss_menu_id: 'TOSS_AME_001' });
  await createRecipe(menuId, ingId, 15);

  const orderId = `order_rename_${Date.now()}`;
  // POS에서 메뉴명을 "아메리카노(리뉴얼)"로 바꿔서 보내와도 item.menuId는 그대로 TOSS_AME_001이다.
  const res = await postWebhook(storeId, createdOrderPayload(orderId, [
    { name: '아메리카노(리뉴얼)', menuId: 'TOSS_AME_001', quantity: 2 },
  ]));
  assert.equal(res.status, 200);

  const ingredient = await knex('ingredients').where({ id: ingId }).first();
  assert.equal(ingredient.stock, 1000 - 15 * 2, '이름이 바뀐 판매도 ID로 매칭되어 재고가 차감되어야 한다');

  // 새 메뉴가 잘못 만들어지지 않고 기존 메뉴 그대로 매칭됐어야 한다.
  const menus = await knex('menus').where({ store_id: storeId });
  assert.equal(menus.length, 1, '이름이 바뀌었다고 새 메뉴가 추가로 생성되면 안 된다');
  assert.equal(menus[0].id, menuId);
});

test('이름으로 매칭됐고 메뉴에 토스 ID가 비어있으면 그 자리에서 자동 연결되고, 이후엔 이름이 바뀌어도 계속 매칭된다', async () => {
  const storeId = await newStore();
  const ingId = await createIngredient(brandId, storeId, { name: '라떼_원두', stock: 1000, threshold: 10 });
  const menuId = await createMenu(brandId, storeId, { name: '라떼' }); // toss_menu_id 없음
  await createRecipe(menuId, ingId, 10);

  const firstOrderId = `order_link_${Date.now()}_1`;
  const res1 = await postWebhook(storeId, createdOrderPayload(firstOrderId, [
    { name: '라떼', menuId: 'TOSS_LATTE_777', quantity: 1 },
  ]));
  assert.equal(res1.status, 200);

  const menuAfterFirst = await knex('menus').where({ id: menuId }).first();
  assert.equal(menuAfterFirst.toss_menu_id, 'TOSS_LATTE_777', '이름으로 매칭된 자리에서 토스 ID가 자동 연결되어야 한다');

  // 다음 판매부터 이름이 바뀌어도 이제는 ID로 잡혀야 한다.
  const secondOrderId = `order_link_${Date.now()}_2`;
  const res2 = await postWebhook(storeId, createdOrderPayload(secondOrderId, [
    { name: '라떼(이름바뀜)', menuId: 'TOSS_LATTE_777', quantity: 3 },
  ]));
  assert.equal(res2.status, 200);

  const ingredient = await knex('ingredients').where({ id: ingId }).first();
  assert.equal(ingredient.stock, 1000 - 10 * 1 - 10 * 3);
  const menus = await knex('menus').where({ store_id: storeId });
  assert.equal(menus.length, 1, '자동 연결 이후 이름이 바뀌어도 새 메뉴가 생기면 안 된다');
});

test('이미 토스 메뉴 ID가 연결된 메뉴는 다른 ID가 들어와도 덮어써지지 않는다', async () => {
  const storeId = await newStore();
  const ingId = await createIngredient(brandId, storeId, { name: '덮어쓰기방지_재료', stock: 1000, threshold: 10 });
  const menuId = await createMenu(brandId, storeId, { name: '덮어쓰기방지메뉴', toss_menu_id: 'TOSS_ORIGINAL' });
  await createRecipe(menuId, ingId, 5);

  const orderId = `order_noverwrite_${Date.now()}`;
  // menuId('TOSS_OTHER')로는 매칭되는 메뉴가 없으므로 이름으로 폴백해서 찾게 되고, 그 자리에서
  // linkMenuToTossId가 호출되지만 이미 TOSS_ORIGINAL이 채워져 있으므로 덮어쓰지 않아야 한다.
  const res = await postWebhook(storeId, createdOrderPayload(orderId, [
    { name: '덮어쓰기방지메뉴', menuId: 'TOSS_OTHER', quantity: 1 },
  ]));
  assert.equal(res.status, 200);

  const menu = await knex('menus').where({ id: menuId }).first();
  assert.equal(menu.toss_menu_id, 'TOSS_ORIGINAL', '이미 연결된 토스 ID는 다른 ID가 들어와도 유지되어야 한다');

  const ingredient = await knex('ingredients').where({ id: ingId }).first();
  assert.equal(ingredient.stock, 1000 - 5, '이름 매칭 자체는 정상적으로 재고를 차감해야 한다');
});

// ── 3. 메뉴 자동 발견 ──────────────────────────────────────────────

test('등록 안 된 메뉴가 팔리면 menus에 자동 생성되고(auto_discovered=true), 레시피가 없으니 재고는 차감되지 않는다', async () => {
  const storeId = await newStore();
  const ingId = await createIngredient(brandId, storeId, { name: '무관재료', stock: 1000, threshold: 10 });

  const orderId = `order_discover_${Date.now()}`;
  const res = await postWebhook(storeId, createdOrderPayload(orderId, [
    { name: '완전신메뉴', menuId: 'TOSS_NEW_999', quantity: 5 },
  ]));
  assert.equal(res.status, 200);

  const discovered = await knex('menus').where({ store_id: storeId, name: '완전신메뉴' }).first();
  assert.ok(discovered, '자동으로 menus 행이 생성되어야 한다');
  assert.equal(!!discovered.auto_discovered, true);
  assert.equal(discovered.toss_menu_id, 'TOSS_NEW_999');

  // 레시피가 전혀 없는 재료라 판매와 무관하게 그대로여야 한다(모르는 레시피를 추측해서 깎지 않는다).
  const ingredient = await knex('ingredients').where({ id: ingId }).first();
  assert.equal(ingredient.stock, 1000);
  const ledgerRows = await knex('stock_ledger').where({ store_id: storeId });
  assert.equal(ledgerRows.length, 0, '레시피 미지정 메뉴는 어떤 재료의 수불부도 남기면 안 된다');

  const alerts = await riskAlertsFor(storeId, 'MENU_UNMATCHED');
  assert.equal(alerts.length, 1, '자동 발견은 MENU_UNMATCHED 리스크 알림을 남겨야 한다');
});

test('같은 자동발견 메뉴가 다시 팔려도 중복 생성되지 않는다', async () => {
  const storeId = await newStore();

  const order1 = `order_dup_${Date.now()}_1`;
  const order2 = `order_dup_${Date.now()}_2`;
  const res1 = await postWebhook(storeId, createdOrderPayload(order1, [
    { name: '중복확인메뉴', menuId: 'TOSS_DUP_1', quantity: 1 },
  ]));
  assert.equal(res1.status, 200);
  const res2 = await postWebhook(storeId, createdOrderPayload(order2, [
    { name: '중복확인메뉴', menuId: 'TOSS_DUP_1', quantity: 2 },
  ]));
  assert.equal(res2.status, 200);

  const menus = await knex('menus').where({ store_id: storeId, name: '중복확인메뉴' });
  assert.equal(menus.length, 1, '같은 메뉴가 다시 팔려도 menus에 중복 생성되면 안 된다');
});

// ── 4. 조용한 실패 감지 ────────────────────────────────────────────

test('레시피가 없는(등록은 됐지만 미지정) 메뉴가 팔리면 MENU_UNMATCHED 알림이 뜬다', async () => {
  const storeId = await newStore();
  const menuId = await createMenu(brandId, storeId, { name: '레시피없음메뉴' }); // 레시피/표준메뉴/세트 전부 없음

  const orderId = `order_norecipe_${Date.now()}`;
  const res = await postWebhook(storeId, createdOrderPayload(orderId, [
    { name: '레시피없음메뉴', quantity: 1 },
  ]));
  assert.equal(res.status, 200);

  const alerts = await riskAlertsFor(storeId, 'MENU_UNMATCHED');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].description, /레시피 미등록/);

  const menus = await knex('menus').where({ id: menuId });
  assert.equal(menus.length, 1, '이미 등록된 메뉴이므로 새 메뉴가 추가로 생기면 안 된다');
});

test('판매로 인해 재고가 음수가 되면 NEGATIVE_STOCK 알림이 뜨고, 재고는 0으로 막히지 않고 그대로 음수로 남는다', async () => {
  const storeId = await newStore();
  const ingId = await createIngredient(brandId, storeId, { name: '음수재료', stock: 5, threshold: 1 });
  const menuId = await createMenu(brandId, storeId, { name: '음수유발메뉴' });
  await createRecipe(menuId, ingId, 100); // 재고보다 훨씬 많이 소모하는 레시피 (레시피 수량 오류 재현)

  const orderId = `order_negative_${Date.now()}`;
  const res = await postWebhook(storeId, createdOrderPayload(orderId, [
    { name: '음수유발메뉴', quantity: 1 },
  ]));
  assert.equal(res.status, 200);

  const ingredient = await knex('ingredients').where({ id: ingId }).first();
  assert.equal(ingredient.stock, 5 - 100, '재고 음수를 0으로 막지 않고 그대로 반영해야 한다(신호를 지우면 안 됨)');

  const alerts = await riskAlertsFor(storeId, 'NEGATIVE_STOCK');
  assert.equal(alerts.length, 1);
});

test('웹훅 시크릿이 없는 가맹점의 요청은 401로 거부되고 WEBHOOK_REJECTED 알림이 뜬다', async () => {
  const storeId = await newStore({ webhook_secret: '', name: '시크릿없는가맹점_메뉴매칭' });
  const rawBody = JSON.stringify({ type: 'ping' });
  const res = await postWebhook(storeId, null, { raw: rawBody, secret: null, headers: signWebhookHeaders('아무값', rawBody) });
  assert.equal(res.status, 401);

  const alerts = await riskAlertsFor(storeId, 'WEBHOOK_REJECTED');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].description, /webhook_secret/);
});

// ── 5. 세트가 재고에 정확히 반영되는가 ──────────────────────────────

test('짜장면(밀가루30g)+짬뽕(밀가루20g) 세트가 2개 팔리면 밀가루가 정확히 100g 빠지고, 수불부 before/after가 실제 재고와 일치한다', async () => {
  const storeId = await newStore();
  const flourId = await createIngredient(brandId, storeId, { name: '세트웹훅_밀가루', stock: 1000, threshold: 10 });

  const jjajangId = await createMenu(brandId, storeId, { name: '세트웹훅_짜장면' });
  await createRecipe(jjajangId, flourId, 30);
  const jjamppongId = await createMenu(brandId, storeId, { name: '세트웹훅_짬뽕' });
  await createRecipe(jjamppongId, flourId, 20);

  const setMenuId = await createMenu(brandId, storeId, { name: '세트웹훅_짜장짬뽕세트' });
  await knex('menu_components').insert([
    { brand_id: brandId, set_menu_id: setMenuId, component_menu_id: jjajangId, quantity: 1 },
    { brand_id: brandId, set_menu_id: setMenuId, component_menu_id: jjamppongId, quantity: 1 },
  ]);

  const orderId = `order_set_${Date.now()}`;
  const res = await postWebhook(storeId, createdOrderPayload(orderId, [
    { name: '세트웹훅_짜장짬뽕세트', quantity: 2 },
  ]));
  assert.equal(res.status, 200);

  const ingredient = await knex('ingredients').where({ id: flourId }).first();
  assert.equal(ingredient.stock, 1000 - 100, '세트 2개 = (30+20)*2 = 100g이 정확히 빠져야 한다');

  const ledgerRows = await knex('stock_ledger').where({ ingredient_id: flourId }).orderBy('id', 'asc');
  assert.equal(ledgerRows.length, 1, '세트 구성 메뉴의 같은 재료 소모는 하나의 수불부 행으로 합산되어야 한다');
  assert.equal(ledgerRows[0].before_stock, 1000);
  assert.equal(ledgerRows[0].after_stock, 900);
  assert.equal(ledgerRows[0].after_stock, ingredient.stock, '수불부 after_stock이 실제 재고와 일치해야 한다');
});
