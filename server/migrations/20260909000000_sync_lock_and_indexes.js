/**
 * 동기화 락 컬럼 + 핫 패스 인덱스 4개 추가.
 *
 * - stores.sync_locked_at: server/src/syncLock.js(acquireStoreSyncLock/releaseStoreSyncLock)가
 *   같은 가맹점에 대해 runAutoSync(3분 주기 크론)와 수동 "지금 동기화"(POST /api/stores/:id/sync)가
 *   동시에 겹치는 것을 막기 위해 쓰는 락 타임스탬프다. NULL이거나 TTL(SYNC_LOCK_TTL_MS)이 지났으면
 *   다시 잡을 수 있다.
 * - 인덱스 4개는 salesIngest.js가 폴링(주 매출 유입 경로)마다 반복 실행하는 조회를 커버한다.
 *
 * SQLite에서 FK가 걸린 stores 테이블에 컬럼을 추가하면 테이블이 통째로 재생성될 수 있다(임시테이블
 * 생성→복사→DROP→RENAME). 20260825030000에서 실제로 겪은 것처럼, 트랜잭션 안에서는 knex가
 * PRAGMA foreign_keys=OFF를 걸지 못해 그 DROP TABLE 시점에 자식 테이블(stores를 참조하는 여러
 * 테이블)이 FK CASCADE로 전멸할 수 있다. 트랜잭션을 꺼서 knex가 PRAGMA를 정상적으로 걸게 한다.
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

// 20260825010000_add_hot_path_indexes.js와 동일한 판별 로직을 그대로 복제한다(그 파일이 바뀌거나
// 사라져도 이 마이그레이션은 독립적으로 재현 가능해야 하므로 import하지 않는다).
function isAlreadyExistsError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error).toLowerCase();
  return ['42p07', '42710'].includes(code)
    || /already exists/.test(message)
    || /duplicate (?:index|relation|object)/.test(message);
}

// `/does not exist/`가 너무 넓어 '테이블이 없다'는 오류까지 삼켰다 — 잘못된 테이블명 오타가
// 조용히 성공으로 처리된다. 인덱스가 없다는 오류로만 범위를 좁힌다.
function isMissingError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error).toLowerCase();
  return code === '42704'                       // pg: undefined_object (인덱스 없음)
    || /no such index/.test(message)            // sqlite
    || /index .* does not exist/.test(message); // pg 메시지 전문
}

async function addIndex(knex, table, columns, indexName) {
  try {
    await knex.schema.table(table, (t) => t.index(columns, indexName));
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

async function dropIndex(knex, table, columns, indexName) {
  try {
    await knex.schema.table(table, (t) => t.dropIndex(columns, indexName));
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
}

// [table, columns, indexName, 근거]
const INDEXES = [
  [
    'menus', ['store_id', 'toss_menu_id'], 'idx_menus_store_toss_menu_id',
    // salesIngest.js:59-60 — 판매 유입마다(폴링 3분 주기) menuId가 있으면 먼저
    // WHERE store_id=? AND toss_menu_id=?로 메뉴를 찾는다. 주 매출 경로에서 주문 라인아이템 수만큼
    // 반복 실행되는 조회라 인덱스가 없으면 매번 menus 테이블 풀스캔이다.
  ],
  [
    'menus', ['store_id', 'name'], 'idx_menus_store_name',
    // salesIngest.js:62-63 — toss_menu_id로 못 찾으면(메뉴가 처음 연결되기 전) 이름으로
    // WHERE store_id=? AND name=?로 재조회한다. 위 인덱스와 함께 매출 유입 경로의 핵심 조회 2건.
  ],
  [
    'alert_log', ['store_id', 'ingredient_id', 'sent_at'], 'idx_alert_log_store_ing_sent',
    // salesIngest.js:323(재고 부족 알림 1시간 쿨다운 체크) — 판매로 재고가 threshold 아래로 떨어질
    // 때마다 WHERE ingredient_id=? AND store_id=? AND sent_at > ?로 최근 알림 존재 여부를 조회한다.
    // 이 조회가 매번 alert_log 풀스캔이면 판매가 몰릴 때(같은 재료가 반복 소진) 누적 비용이 커진다.
  ],
  [
    'alert_log', ['sent_at'], 'idx_alert_log_sent_at',
    // index.js의 runDataCleanup(오래된 데이터 정리, 1일 주기)이 risk_alerts/order_history와 같은
    // 보존정책을 alert_log에도 확장할 근거 컬럼 — sent_at 단독 범위 조회(오래된 행 삭제)는 위
    // 복합 인덱스(store_id, ingredient_id, sent_at)로는 선두 컬럼이 안 맞아 커버되지 않는다.
  ],
];

exports.up = async function up(knex) {
  await addColumnIfMissing(knex, 'stores', 'sync_locked_at', (t) => {
    t.datetime('sync_locked_at').nullable();
  });

  for (const [table, columns, indexName] of INDEXES) {
    await addIndex(knex, table, columns, indexName);
  }
};

exports.down = async function down(knex) {
  for (const [table, columns, indexName] of [...INDEXES].reverse()) {
    await dropIndex(knex, table, columns, indexName);
  }

  await dropColumnIfExists(knex, 'stores', 'sync_locked_at');
};

// stores는 FK가 걸린 테이블이라 sqlite에서 컬럼 추가가 재생성을 유발할 수 있다(위 설명 참고,
// 20260825030000_menu_recipe_extensibility.js에서 실제로 겪은 사고와 동일한 원인).
exports.config = { transaction: false };
