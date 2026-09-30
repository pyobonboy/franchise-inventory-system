'use strict';

const path = require('node:path');
const os = require('node:os');

// helpers.js를 require하기 전에 이 파일 전용 임시 DB 경로를 지정 (server/data.db를 건드리지 않기 위함).
process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-menuresolver-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, teardown,
  createBrand, createStore, createIngredient, createMenu, createRecipe,
} = require('./helpers');
const { resolveConsumption, resolveConsumptionBulk } = require('../src/menuResolver');

// menuResolver는 순수 계산에 가깝고(HTTP 경유 없이 DB 픽스처 + knex만 필요), 웹훅 계층을 거치면
// 응답 코드/부수효과(재고 차감, 알림)만 관찰 가능해 "규칙 5가지"를 직접·명확하게 검증하기 어렵다.
// 대신 웹훅/HTTP 계층 검증은 별도 파일(webhook-menu-matching.test.js)에서 이 파일이 보장하는 계산이
// 실제 재고 차감에 올바르게 연결되는지를 다룬다. (작업 지침의 "판단해서 정하고 근거를 보고" 부분)
let brandId;
let storeId;

before(async () => {
  await initDb();
  brandId = await createBrand();
  storeId = await createStore(brandId);
});

after(async () => {
  await teardown();
});

async function createComponent(setMenuId, componentMenuId, quantity) {
  await knex('menu_components').insert({ brand_id: brandId, set_menu_id: setMenuId, component_menu_id: componentMenuId, quantity });
}

// 계산이 실제로 멈추지 않고(무한루프) 끝나는지 보장하는 워치독. 순환 참조는 visiting 집합으로
// 즉시 예외를 던지도록 구현되어 있어 원래는 걸릴 일이 없어야 하지만, 회귀로 무한루프가 생기면
// 이 테스트 프로세스 자체가 영원히 매달려 CI가 타임아웃날 때까지 원인을 알 수 없게 된다 — 그
// 대신 여기서 명확한 에러로 실패시킨다.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[워치독] ${label}이(가) ${ms}ms 안에 끝나지 않았습니다 — 무한루프 의심`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

test('규칙1: 자기 레시피가 있으면 그것을 쓴다', async () => {
  const ingId = await createIngredient(brandId, storeId, { name: '규칙1_재료' });
  const menuId = await createMenu(brandId, storeId, { name: '규칙1_메뉴' });
  await createRecipe(menuId, ingId, 5);
  const menu = await knex('menus').where({ id: menuId }).first();

  const result = await withTimeout(resolveConsumption(knex, menu, 3), 3000, '규칙1 계산');
  assert.deepEqual(result, [{ ingredient_id: ingId, amount: 15 }]);
});

test('규칙2: 자기 레시피가 없고 recipe_source_menu_id가 있으면 표준 메뉴의 레시피를 대신 쓴다', async () => {
  const ingId = await createIngredient(brandId, storeId, { name: '규칙2_재료' });
  const stdMenuId = await createMenu(brandId, null, { name: '규칙2_표준메뉴', store_id: null });
  await createRecipe(stdMenuId, ingId, 7);
  const storeMenuId = await createMenu(brandId, storeId, { name: '규칙2_매장메뉴', recipe_source_menu_id: stdMenuId });
  const menu = await knex('menus').where({ id: storeMenuId }).first();

  const result = await withTimeout(resolveConsumption(knex, menu, 2), 3000, '규칙2 계산');
  assert.deepEqual(result, [{ ingredient_id: ingId, amount: 14 }]);
});

test('규칙2 연장: recipe_source_menu_id 체인(표준메뉴가 또 다른 표준메뉴를 가리킴)도 재귀적으로 해석된다', async () => {
  const ingId = await createIngredient(brandId, storeId, { name: '체인_재료' });
  const rootMenuId = await createMenu(brandId, null, { name: '체인_최상위표준', store_id: null });
  await createRecipe(rootMenuId, ingId, 4);
  const midMenuId = await createMenu(brandId, null, { name: '체인_중간표준', store_id: null, recipe_source_menu_id: rootMenuId });
  const leafMenuId = await createMenu(brandId, storeId, { name: '체인_매장메뉴', recipe_source_menu_id: midMenuId });
  const menu = await knex('menus').where({ id: leafMenuId }).first();

  const result = await withTimeout(resolveConsumption(knex, menu, 5), 3000, '체인 계산');
  assert.deepEqual(result, [{ ingredient_id: ingId, amount: 20 }]);
});

test('규칙3+세트전용재료: 세트는 구성 메뉴를 펼쳐 수량을 곱해 합산하고, 세트 자신의 레시피도 함께 더한다', async () => {
  const flourId = await createIngredient(brandId, storeId, { name: '세트_밀가루', stock: 100000 });
  const boxId = await createIngredient(brandId, storeId, { name: '세트_포장용기', stock: 100000 });

  const jjajangId = await createMenu(brandId, storeId, { name: '세트_짜장면' });
  await createRecipe(jjajangId, flourId, 30);
  const jjamppongId = await createMenu(brandId, storeId, { name: '세트_짬뽕' });
  await createRecipe(jjamppongId, flourId, 20);

  const setMenuId = await createMenu(brandId, storeId, { name: '세트_짜장짬뽕세트' });
  await createRecipe(setMenuId, boxId, 1); // 세트 전용 재료: 포장용기
  await createComponent(setMenuId, jjajangId, 1);
  await createComponent(setMenuId, jjamppongId, 1);

  const menu = await knex('menus').where({ id: setMenuId }).first();
  const result = await withTimeout(resolveConsumption(knex, menu, 2), 3000, '세트 계산'); // 세트 2개 판매

  const byIngredient = new Map(result.map(r => [r.ingredient_id, r.amount]));
  assert.equal(byIngredient.get(flourId), (30 + 20) * 2, '구성 메뉴 밀가루 소모량이 정확히 합산되어야 한다');
  assert.equal(byIngredient.get(boxId), 1 * 2, '세트 자신의 레시피(포장용기)도 함께 반영되어야 한다');
  assert.equal(result.length, 2, '재료 종류는 밀가루/포장용기 2종이어야 한다');
});

test('순환 참조(A가 B를 품고 B가 A를 품음)는 무한루프 대신 즉시 에러를 던진다', async () => {
  const menuAId = await createMenu(brandId, storeId, { name: '순환_A' });
  const menuBId = await createMenu(brandId, storeId, { name: '순환_B' });
  await createComponent(menuAId, menuBId, 1);
  await createComponent(menuBId, menuAId, 1);

  const menuA = await knex('menus').where({ id: menuAId }).first();

  await assert.rejects(
    () => withTimeout(resolveConsumption(knex, menuA, 1), 3000, '순환참조 계산'),
    /순환 참조/,
    '순환 참조를 감지하면 명확한 에러를 던져야 한다(조용히 넘어가면 과소평가된 소진량이 사입 오탐/누락으로 이어진다)'
  );
});

test('규칙5: 레시피/표준메뉴연결/세트구성이 전부 없으면 빈 배열을 반환한다', async () => {
  const emptyMenuId = await createMenu(brandId, storeId, { name: '아무것도없는메뉴' });
  const menu = await knex('menus').where({ id: emptyMenuId }).first();
  const result = await withTimeout(resolveConsumption(knex, menu, 1), 3000, '빈 메뉴 계산');
  assert.deepEqual(result, []);
});

test('메뉴가 없으면(null/id 없음) resolveConsumption은 빈 배열을 반환한다', async () => {
  assert.deepEqual(await resolveConsumption(knex, null, 1), []);
  assert.deepEqual(await resolveConsumption(knex, {}, 1), []);
});

test('resolveConsumption(단건)과 resolveConsumptionBulk(집계)의 결과가 서로 일치한다', async () => {
  const i1 = await createIngredient(brandId, storeId, { name: '집계_재료1' });
  const i2 = await createIngredient(brandId, storeId, { name: '집계_재료2' });

  const stdMenuId = await createMenu(brandId, null, { name: '집계_표준메뉴', store_id: null });
  await createRecipe(stdMenuId, i1, 10);
  const menuAId = await createMenu(brandId, storeId, { name: '집계_A', recipe_source_menu_id: stdMenuId }); // 표준메뉴 경유

  const menuBId = await createMenu(brandId, storeId, { name: '집계_B' });
  await createRecipe(menuBId, i2, 5); // 자기 레시피

  const menuSetId = await createMenu(brandId, storeId, { name: '집계_세트' });
  await createRecipe(menuSetId, i1, 1); // 세트 전용
  await createComponent(menuSetId, menuAId, 2);
  await createComponent(menuSetId, menuBId, 1);

  const [menuA, menuB, menuSet] = await Promise.all([
    knex('menus').where({ id: menuAId }).first(),
    knex('menus').where({ id: menuBId }).first(),
    knex('menus').where({ id: menuSetId }).first(),
  ]);

  const sales = [
    { menu: menuSet, quantity: 3 },
    { menu: menuB, quantity: 2 },
    { menu: menuA, quantity: 4 },
  ];

  // 단건 계산을 판매 건마다 반복 호출해 수동으로 합산 (기대값)
  const expected = new Map();
  for (const sale of sales) {
    const rows = await withTimeout(resolveConsumption(knex, sale.menu, sale.quantity), 3000, '단건 계산(기대값 산출)');
    for (const r of rows) expected.set(r.ingredient_id, (expected.get(r.ingredient_id) || 0) + r.amount);
  }

  const bulkResult = await withTimeout(resolveConsumptionBulk(knex, sales), 5000, '집계 계산');

  assert.equal(bulkResult.size, expected.size);
  for (const [ingId, amount] of expected) {
    assert.equal(bulkResult.get(ingId), amount, `재료 id=${ingId} 소모량이 단건 합산과 일치해야 한다`);
  }
});

test('resolveConsumptionBulk는 매칭 실패(menu가 null/undefined)한 판매 건을 건너뛴다', async () => {
  const menuId = await createMenu(brandId, storeId, { name: '집계_스킵테스트' });
  const ingId = await createIngredient(brandId, storeId, { name: '집계_스킵재료' });
  await createRecipe(menuId, ingId, 9);
  const menu = await knex('menus').where({ id: menuId }).first();

  const sales = [
    { menu: null, quantity: 100 },
    { menu: undefined, quantity: 100 },
    { menu, quantity: 2 },
  ];
  const result = await withTimeout(resolveConsumptionBulk(knex, sales), 3000, '스킵 계산');
  assert.equal(result.size, 1);
  assert.equal(result.get(ingId), 18);
});
