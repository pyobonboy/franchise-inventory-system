'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-migrations-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, teardown,
  createBrand, createStore, createMenu, createIngredient, createRecipe,
} = require('./helpers');
const { isProduction } = require('../src/db/schema');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function migrationFileCount() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js')).length;
}

// schema.js의 indexExists와 동일한 방언 분기 — 여기서는 하나의 테이블이 가진 인덱스 이름 목록 전체가
// 필요해서 별도로 구현한다(schema.js는 인덱스 존재 여부만 반환하는 내부 함수라 재사용 불가).
async function indexNames(table) {
  if (isProduction) {
    const r = await knex.raw('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?', [table]);
    return r.rows.map(row => row.indexname);
  }
  const rows = await knex.raw(`PRAGMA index_list("${table}")`);
  return rows.map(r => r.name);
}

before(async () => {
  await initDb(); // initDb() 내부에서 이미 knex.migrate.latest()까지 실행됨
});

after(async () => {
  await teardown();
});

test('initDb() 이후 모든 마이그레이션을 하나씩 되돌렸다가 다시 전부 적용해도 정상 복구된다', async () => {
  const total = migrationFileCount();
  assert.ok(total >= 1);

  for (let i = 0; i < total; i++) {
    await knex.migrate.down();
  }
  const [completedAfterDown] = await knex.migrate.list();
  assert.equal(completedAfterDown.length, 0, '전체 마이그레이션을 되돌리면 완료 목록이 비어야 한다');

  await knex.migrate.latest();
  const [completedAfterUp] = await knex.migrate.list();
  assert.equal(completedAfterUp.length, total, '다시 latest()를 실행하면 전체 마이그레이션이 재적용되어야 한다');
});

test('20260825030000(menu_recipe_extensibility) down/up 왕복 후에도 recipes 행이 소실되지 않는다', async () => {
  const brandId = await createBrand();
  const storeId = await createStore(brandId);
  const ingredientId = await createIngredient(brandId, storeId, { name: '회귀테스트재료' });
  const menuId = await createMenu(brandId, storeId, { name: '회귀테스트메뉴' });
  await createRecipe(menuId, ingredientId, 7);

  // 위 테스트가 끝나면서 이미 전체 latest() 상태로 되돌려놨으므로, 가장 최근에 적용된 두 마이그레이션
  // (20260909000000, 그 다음으로 20260825030000)을 순서대로 한 단계씩 내린다.
  await knex.migrate.down(); // 20260909000000_sync_lock_and_indexes 되돌림
  await knex.migrate.down(); // 20260825030000_menu_recipe_extensibility 되돌림

  const afterDown = await knex('recipes').where({ menu_id: menuId, ingredient_id: ingredientId }).first();
  assert.ok(afterDown, 'down() 이후에도 recipes 행이 남아있어야 한다 (FK CASCADE로 전멸하면 안 됨)');
  assert.equal(afterDown.amount, 7);

  await knex.migrate.latest();
  const afterUp = await knex('recipes').where({ menu_id: menuId, ingredient_id: ingredientId }).first();
  assert.ok(afterUp, 'up() 이후에도 recipes 행이 남아있어야 한다');
  assert.equal(afterUp.amount, 7);
});

test('sync_locked_at 컬럼과 신규 인덱스 4개가 실제로 존재한다', async () => {
  const hasColumn = await knex.schema.hasColumn('stores', 'sync_locked_at');
  assert.equal(hasColumn, true);

  const menuIndexNames = await indexNames('menus');
  assert.ok(menuIndexNames.includes('idx_menus_store_toss_menu_id'));
  assert.ok(menuIndexNames.includes('idx_menus_store_name'));

  const alertLogIndexNames = await indexNames('alert_log');
  assert.ok(alertLogIndexNames.includes('idx_alert_log_store_ing_sent'));
  assert.ok(alertLogIndexNames.includes('idx_alert_log_sent_at'));
});
