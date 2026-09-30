/**
 * 핫 패스 인덱스 추가 — server/docs/db-schema-review.md 5번 항목("핫 패스에 인덱스가 하나도 없음")의
 * 후속 조치. 기존 4개 인덱스(schema.js의 addIndexIfMissing 호출부)는 store_id 기준 조회만 커버하는데,
 * 실제 라우트를 읽어보면 brand_id로만 좁히는 조회(HQ가 특정 가맹점을 선택하지 않은 "전체" 화면)와,
 * FK 컬럼인데도 색인이 아예 없는 테이블(purchase_order_items.order_id, order_history.order_id 등)이
 * 다수 발견되어 이번에 추가한다.
 *
 * 기존 인덱스와의 관계:
 *  - orders(store_id, processed_at), sales_items(store_id, sold_at), purchase_orders(store_id, status),
 *    risk_alerts(brand_id, status)는 이미 있으므로 여기서 다시 만들지 않는다.
 *  - 아래 인덱스들은 선행 컬럼 조합이 달라서(예: store_id 대신 brand_id, 혹은 아예 다른 컬럼) 기존
 *    인덱스로 커버되지 않는 조회만 골랐다.
 *
 * SQLite/PostgreSQL 양쪽에서 서버가 여러 번(재기동마다) 이 마이그레이션을 실행해도(정상적으로는
 * knex_migrations 이력 때문에 한 번만 실행되지만, 방어적으로) 같은 인덱스가 이미 있으면 조용히
 * 넘어가도록 addIndex/dropIndex 헬퍼가 "이미 존재/없음" 에러를 흡수한다. server/src/db/schema.js의
 * addIndexIfMissing/isAlreadyExistsError와 동일한 판별 로직이지만, 마이그레이션은 나중에 그 헬퍼가
 * 바뀌거나 사라져도 그대로 재현 가능해야 하므로 이 파일 안에 독립적으로 복제해둔다(schema.js를
 * import하지 않는다).
 */

function isAlreadyExistsError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error).toLowerCase();
  return ['42p07', '42710'].includes(code) // Postgres: duplicate_table / duplicate_object
    || /already exists/.test(message)
    || /duplicate (?:index|relation|object)/.test(message);
}

function isMissingError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || error).toLowerCase();
  return code === '42704' // Postgres: undefined_object
    || /no such index/.test(message) // SQLite
    || /does not exist/.test(message); // Postgres
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

// [table, columns, indexName, 근거 주석]
const INDEXES = [
  [
    'orders', ['brand_id', 'processed_at'], 'idx_orders_brand_processed_at',
    // server/src/routes/api.js의 /dashboard가 내부적으로 호출하는 dayStats()는 today/yesterday/
    // lastWeekSameDay + 최근 7일 추이까지 한 번의 대시보드 요청마다 총 10번 실행되는데, HQ가 특정
    // 가맹점을 선택하지 않은 "전체" 보기에서는 orders를 brand_id + order_state + processed_at 범위로만
    // 필터링하고 store_id는 WHERE에 없다(if (sid) financeQ.where(...)로 조건부). 같은 파일의
    // /dashboard/channel-breakdown도 store_id 미지정 시 brand_id + processed_at 범위만 쓴다.
    // 기존 idx_orders_store_processed_at(store_id, processed_at)은 store_id가 WHERE에 없으면
    // 전혀 쓰이지 못하므로 별도로 필요하다.
  ],
  [
    'sales_items', ['brand_id', 'sold_at'], 'idx_sales_items_brand_sold_at',
    // server/src/routes/api.js의 /analytics(salesQ, dailyQ)와 /store-rankings(salesRows)가
    // store_id 미지정("전체 가맹점" 조회) 시 sales_items를 brand_id + sold_at 범위로만 필터링한다.
    // 기존 idx_sales_items_store_sold_at(store_id, sold_at)은 이 경우 쓰이지 못한다.
  ],
  [
    'purchase_orders', ['brand_id', 'status'], 'idx_purchase_orders_brand_status',
    // server/src/routes/api.js의 /dashboard가 매 요청마다 실행하는 pendingOrders/paymentPending
    // COUNT(*) 쿼리 2개와 overdueQ(결제대기 24시간 방치 목록)가 전부 store_id 없이 brand_id + status로만
    // 필터링한다. server/src/routes/risks.js의 checkPaymentOverdue(1시간마다 도는 크론)도
    // brand_id + status='PAYMENT_PENDING'로 조회한다. 기존 idx_purchase_orders_store_status는
    // store_id가 WHERE에 없는 이 조합들에는 쓰이지 못한다.
  ],
  [
    'purchase_orders', ['store_id', 'created_at'], 'idx_purchase_orders_store_created_at',
    // server/src/routes/orders.js의 checkSalesDownOrderUp(발주 제출마다 실행)이 store_id + created_at
    // 범위로 최근 7일/직전 7일 발주금액을 2번씩 조회하고, server/src/routes/api.js의
    // getIngredientComparison(사입 이상 모니터링 /purchase-anomalies가 가맹점마다 반복 호출)도
    // 동일한 조합(po.brand_id + po.store_id + po.created_at 범위)을 쓴다. status는 whereNotIn이라
    // 인덱스 선두 컬럼으로는 효율이 낮아 created_at 범위 쪽을 선두 다음에 둔다.
  ],
  [
    'risk_alerts', ['brand_id', 'store_id', 'type'], 'idx_risk_alerts_brand_store_type',
    // server/src/routes/risks.js의 createRisk()는 리스크가 감지될 때마다(과다사입 비율 체크, 폐기과다,
    // 결제미완료 크론, 재고부족 크론, 매출감소·발주증가 체크 등 거의 모든 리스크 감지 경로) 중복 여부를
    // WHERE brand_id, store_id, type AND status IN (OPEN/ACKNOWLEDGED/IN_PROGRESS)로 먼저 조회한다.
    // 기존 idx_risk_alerts_brand_status(brand_id, status)는 store_id/type이 선두에 없어 이 조회에는
    // 쓰이지 못하고, createRisk가 risk_alerts에서 가장 자주 실행되는 조회라 별도로 필요하다.
  ],
  [
    'stock_ledger', ['store_id', 'created_at'], 'idx_stock_ledger_store_created_at',
    // stock_ledger는 판매/납품/환불/폐기/실사조정 등 재고가 바뀌는 모든 경로가 기록되는 테이블이라
    // orders/sales_items 다음으로 빠르게 커지는데 지금은 PK 외 인덱스가 전혀 없다.
    // server/src/routes/stock.js의 /ledger(수불부 조회 화면, StockLedger.jsx)가
    // brand_id + store_id로 좁힌 뒤 created_at desc로 정렬해 최근 500건을 가져온다.
  ],
  [
    'waste_logs', ['store_id', 'waste_date'], 'idx_waste_logs_store_waste_date',
    // server/src/routes/risks.js의 checkHighWaste(가맹점이 폐기를 등록할 때마다 매번 호출됨,
    // server/src/routes/waste.js POST '/' 참고)가 brand_id + store_id + waste_date(최근 7일)로 집계한다.
    // waste_logs에는 지금 PK 외 인덱스가 없다.
  ],
  [
    'purchase_order_items', ['order_id'], 'idx_purchase_order_items_order_id',
    // order_id는 FK지만 Postgres/SQLite 둘 다 FK 컬럼을 자동으로 색인하지 않는다. 발주서 상세 조회
    // (server/src/routes/orders.js GET '/:id', 화면을 열 때마다), 품목 수정(PUT '/:id/items/:itemId'),
    // 그리고 납품완료/환불마다 실행되는 applyDeliveryStock/applyItemStock이 전부
    // WHERE order_id=?로 purchase_order_items를 조회한다 — 이 테이블에서 가장 빈번한 조회 패턴이다.
  ],
  [
    'order_history', ['order_id', 'created_at'], 'idx_order_history_order_id_created_at',
    // 발주서 상세 조회(server/src/routes/orders.js GET '/:id')가 매번 order_history를
    // WHERE order_id=? ORDER BY created_at DESC로 조회한다. 이 테이블에도 PK 외 인덱스가 없다.
  ],
];

exports.up = async function up(knex) {
  for (const [table, columns, indexName] of INDEXES) {
    await addIndex(knex, table, columns, indexName);
  }
};

exports.down = async function down(knex) {
  // up의 역순으로 제거 (필수는 아니지만 관례상 생성 순서와 대칭되게 정리)
  for (const [table, columns, indexName] of [...INDEXES].reverse()) {
    await dropIndex(knex, table, columns, indexName);
  }
};
