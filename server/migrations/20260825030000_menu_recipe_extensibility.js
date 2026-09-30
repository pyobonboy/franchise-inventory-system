/**
 * 메뉴/레시피 구조 확장 — 브랜드 표준 메뉴 연결 + 세트메뉴 구성 + 자동 발견 메뉴 표시.
 *
 * 배경: 지금은 메뉴가 매장별로만 존재해서(menus.store_id가 항상 특정 가맹점을 가리킴) 같은
 * 메뉴를 파는 매장마다 메뉴/레시피를 각각 등록해야 하고, 세트메뉴는 재료를 통째로 다시 적는
 * 수밖에 없어 구성 메뉴 레시피가 바뀌면 세트도 손으로 맞춰야 한다. 세트에 레시피가 없으면
 * "예상 소진량 0"으로 계산되어 사입 감시(server/src/routes/api.js의 getIngredientComparison)를
 * 그대로 회피하는 구멍이 된다. 이 마이그레이션은 그 구멍을 메우기 위한 스키마만 추가한다 —
 * 실제 계산 로직은 server/src/menuResolver.js.
 *
 * - menus.recipe_source_menu_id: 이 메뉴에 자기 레시피가 없으면 여기 지정된 메뉴(브랜드 표준
 *   메뉴)의 레시피를 대신 쓴다. 자기 참조 FK라 SET NULL로 걸어둔다 — 표준 메뉴가 삭제돼도
 *   이 메뉴 자체가 같이 삭제되면(CASCADE) 안 되고, 그냥 "레시피 없음" 상태로 돌아가야 한다.
 * - menus.auto_discovered: 판매 유입 중 등록되지 않은 메뉴를 만나 자동 생성된 메뉴인지(기본
 *   false). 본사가 "레시피 지정 필요" 목록을 뽑을 때 쓴다(server/src/routes/webhook.js 참고).
 * - menu_components: 세트메뉴 구성. set_menu_id 1개당 component_menu_id 여러 개 + 개당 수량.
 *
 * menus.store_id를 NULL로 두면 "브랜드 공통 메뉴"로 취급하는 설계(ingredients가 이미 쓰는
 * 패턴, server/src/routes/api.js의 GET /ingredients 참고)를 메뉴에도 쓰려 했으나, 이 컬럼
 * 자체는 이미 nullable이라(schema.js의 createIfMissing('menus', ...) 정의에 notNullable()이
 * 없음, 직접 확인함) 이 마이그레이션에서 컬럼을 바꿀 필요는 없다. 다만 server/src/db/schema.js의
 * initDb()가 서버 기동마다(딱 1회가 아니라 매번) 조건 없이
 * `knex('menus').whereNull('store_id').update({ store_id: defaultStoreId })`를 실행한다는 걸
 * 실제로 재현해서 확인했다 — store_id를 NULL로 둔 메뉴가 있어도 다음 서버 재기동 때 임의의
 * 기본 가맹점 id로 되돌아간다(ingredients도 동일 패턴이라 "브랜드 공통 재료"도 같은 문제를
 * 이미 안고 있다). initDb()는 이번 작업에서 수정 금지 대상이라 이 마이그레이션에서 고칠 수
 * 없다 — 세트/표준메뉴 레시피 연결은 store_id에 의존하지 않고 recipe_source_menu_id /
 * menu_components만으로 동작하도록 menuResolver.js를 설계해 이 문제를 우회했다. store_id=NULL
 * "브랜드 공통 메뉴" 목록 조회 UI를 다음 단계에서 만든다면 이 initDb() 백필부터 먼저 손봐야
 * 한다는 점을 최종 보고에 남긴다.
 */

async function hasColumn(knex, table, column) {
  return knex.schema.hasColumn(table, column);
}

async function addColumnIfMissing(knex, table, column, builder) {
  const has = await hasColumn(knex, table, column);
  if (!has) await knex.schema.table(table, (t) => builder(t));
}

async function dropColumnIfExists(knex, table, column) {
  const has = await hasColumn(knex, table, column);
  if (has) await knex.schema.table(table, (t) => t.dropColumn(column));
}

exports.up = async function up(knex) {
  await addColumnIfMissing(knex, 'menus', 'recipe_source_menu_id', (t) => {
    t.integer('recipe_source_menu_id').nullable().references('menus.id').onDelete('SET NULL');
  });
  await addColumnIfMissing(knex, 'menus', 'auto_discovered', (t) => {
    t.boolean('auto_discovered').defaultTo(false);
  });

  const hasMenuComponents = await knex.schema.hasTable('menu_components');
  if (!hasMenuComponents) {
    await knex.schema.createTable('menu_components', (t) => {
      t.increments('id');
      t.integer('brand_id').references('brands.id').onDelete('CASCADE');
      // 세트 자체가 지워지면 구성 관계도 의미가 없으니 CASCADE. 구성 메뉴(예: 짜장면) 쪽이 지워질
      // 때도 마찬가지 — 존재하지 않는 메뉴를 가리키는 구성 행이 남아있으면 menuResolver가 매번
      // "메뉴 없음"을 만나 조용히 그 구성만 빠진 채 계산하게 되는데, 그보다는 구성 관계 자체를
      // 없애 세트 레시피가 즉시 눈에 띄게 줄어들도록(운영자가 알아챌 수 있게) 하는 편이 낫다.
      t.integer('set_menu_id').notNullable().references('menus.id').onDelete('CASCADE');
      t.integer('component_menu_id').notNullable().references('menus.id').onDelete('CASCADE');
      t.float('quantity').notNullable().defaultTo(1); // 세트 1개당 이 구성 메뉴 몇 개
      t.datetime('created_at').defaultTo(knex.fn.now());
      // 같은 세트에 같은 구성 메뉴를 두 번 등록하면 수량이 어느 쪽 기준인지 모호해진다 —
      // 수량을 늘리고 싶으면 quantity 값 자체를 올리게 강제한다.
      t.unique(['set_menu_id', 'component_menu_id']);
    });
  }
};

exports.down = async function down(knex) {
  const hasMenuComponents = await knex.schema.hasTable('menu_components');
  if (hasMenuComponents) await knex.schema.dropTable('menu_components');

  await dropColumnIfExists(knex, 'menus', 'auto_discovered');
  await dropColumnIfExists(knex, 'menus', 'recipe_source_menu_id');
};

// SQLite는 FK가 걸린 컬럼을 추가/삭제할 때 테이블을 통째로 재생성한다(임시테이블 생성→복사→DROP→RENAME).
// knex가 트랜잭션 안에서는 PRAGMA foreign_keys=OFF를 걸지 못해, 그 DROP TABLE menus 시점에
// recipes가 FK CASCADE로 전멸한다(up()/down() 모두 재현됨). 트랜잭션을 끄면 knex가 PRAGMA를
// 정상적으로 걸어 재생성이 안전하게 끝난다.
exports.config = { transaction: false };
