// DB 방언별 타임스탬프 포매터.
//
// sqlite의 `knex.fn.now()`(CURRENT_TIMESTAMP)는 'YYYY-MM-DD HH:MM:SS'(UTC) 형식으로 저장되는데, 코드가
// `new Date().toISOString()`('...T...Z')과 문자열로 비교하면 공백(0x20) < 'T'(0x54)라 같은 날짜의 비교가
// 항상 거짓이 된다. 실제로 재고부족 알림 1시간 쿨다운이 통째로 무력화됐고(주문 4건 → alert_log 4행),
// 수불부 기간 합계에서 당일분이 빠졌으며, 정리 크론은 로컬에서 아무것도 지우지 못했다.
// 운영(Postgres)은 timestamptz라 정상 동작해서 로컬에서만 조용히 틀렸다.
//
// **이 포매터는 `knex.fn.now()`가 기본값인 컬럼과의 비교에만 쓴다** — alert_log.sent_at, stock_ledger.created_at,
// risk_alerts.created_at, order_history.created_at, purchase_orders.created_at 등.
// `orders.processed_at`, `purchase_orders.paid_at`처럼 애플리케이션이 ISO 문자열을 직접 넣는 컬럼에 쓰면
// 오히려 어긋나므로 그런 곳에는 기존처럼 ISO를 그대로 쓴다.
const { isProduction } = require('./db/schema');

function toDbTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`toDbTime: 잘못된 시각 값 (${value})`);
  return isProduction ? d.toISOString() : d.toISOString().slice(0, 19).replace('T', ' ');
}

function dbNow() {
  return toDbTime(Date.now());
}

function dbTimeAgo(ms) {
  return toDbTime(Date.now() - ms);
}

// 이 프로젝트의 "오늘"은 항상 KST다. 운영 서버 TZ가 UTC면 서버 로컬 자정은 KST와 9시간 어긋나고,
// orders.js의 isPastOrderDeadline은 이미 KST를 명시하고 있어 기준이 갈라져 있었다.
function kstDayRange(dateLike) {
  const base = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const kst = new Date(base.getTime() + 9 * 3600000);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth(), d = kst.getUTCDate();
  // KST 자정/23:59:59.999를 UTC epoch로 만든 뒤 다시 9시간을 빼 실제 UTC 시각으로 되돌린다
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0) - 9 * 3600000;
  const endUtcMs = Date.UTC(y, m, d, 23, 59, 59, 999) - 9 * 3600000;
  return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() };
}

// KST 기준 오늘 00:00:00.000
function dbStartOfKstToday() {
  return toDbTime(kstDayRange(new Date()).startIso);
}

module.exports = { toDbTime, dbNow, dbTimeAgo, dbStartOfKstToday, kstDayRange };
