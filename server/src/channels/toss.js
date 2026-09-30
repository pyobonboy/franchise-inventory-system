// 토스플레이스 매출 동기화. 배달앱 연동을 켠 매장은 배민/쿠팡이츠/요기요 주문도 토스플레이스
// POS로 같이 들어오고, 주문 원본(order.source)에 출처가 표시된다 — 참고용 프로젝트
// (C:\Users\han\Desktop\토스 대시보드\dashboardtoss\lib\sync.ts:126, channel: stringOrNull(order.source))
// 에서 확인. 그래서 배민/쿠팡이츠/요기요를 별도 API로 당겨올 필요 없이, 이 동기화 하나가
// 가져오는 주문의 order.source 값을 그대로 channel로 저장하면 채널별 매출이 나온다.
// order.source의 실제 문자열 값(예: "BAEMIN"인지 다른 표기인지)은 실제 동기화 데이터로
// 확인 전이라 라벨은 원문 그대로 노출하고, 값을 확인한 뒤 CHANNEL_LABELS에 다듬어 넣으면 된다.
const { knex } = require('../db/schema');
const { broadcast } = require('../routes/sse');
const { ingestCompletedOrder, reverseCancelledOrder, emitRiskNotifications } = require('../salesIngest');

// 알려진 것부터 채워두고, 실제 동기화된 데이터를 보고 나머지 실제 값으로 보완할 것
const CHANNEL_LABELS = {
  POS: '홀(POS)',
};
function labelFor(source) {
  return CHANNEL_LABELS[source] || source;
}

// 토스플레이스 API는 2022-01-01T00:00:00Z(UTC) 이전 시각을 from으로 보내면 400 에러를 반환함 (API 자체 제약)
const TOSS_PLACE_MIN_TS = Date.parse('2022-01-01T00:00:00Z');

function isConfigured(store) {
  return !!(process.env.TOSS_PLACE_ACCESS_KEY && process.env.TOSS_PLACE_SECRET_KEY && store.toss_store_id);
}

// 'YYYY-MM-DD' 날짜 문자열을 KST(UTC+9) 기준 하루의 시작/끝 epoch ms로 바꾼다. 예전에는 이 변환을
// syncStoreSales 내부에서만 하고 있어서 index.js의 runAutoSync가 매번 문자열을 만들었다 다시 이
// 파일이 파싱하는 왕복이 있었는데, 그 왕복 자체가 "UTC 날짜 문자열을 KST 23:59:59로 해석"하는
// 버그의 원인이었다(아래 index.js 쪽 주석 참고). 지금은 fromTs/toTs를 epoch ms로 직접 주고받아
// 이 변환이 필요한 곳(주로 테스트/수동 조회)에서만 명시적으로 쓴다.
function kstDayStartTs(dateStr) {
  return new Date(dateStr + 'T00:00:00+09:00').getTime();
}
function kstDayEndTs(dateStr) {
  return new Date(dateStr + 'T23:59:59.999+09:00').getTime();
}

// 주문 1건을 상태에 맞는 함수(ingestCompletedOrder/reverseCancelledOrder)로 보내고, 트랜잭션 커밋
// 후 리스크 알림/재고부족 브로드캐스트까지 처리한다. 실패해도 예외를 밖으로 던지지 않고 로그만
// 남긴다 — 호출부(syncStoreSales)가 "주문 한 건 실패가 전체 동기화를 막으면 안 된다"는 요구사항을
// 지키려면 이 함수 자체가 그 경계여야 한다.
// 반환: { inserted, failed, skipped } — 예전엔 개수(반영된 라인아이템 수) 하나만 반환해서, 주문이
// 전량 실패해도 호출부가 "성공"으로 보고 last_synced_at을 갱신하고 SYNC_FAILED 카운터까지 리셋했다
// — 그 구간 주문이 다음 창(최근 2일)에서도 안 걸리면 영영 빠진다. failed>0을 호출부가 실패로
// 취급할 수 있어야 last_synced_at을 안 밀고 재시도 창에 남길 수 있다.
async function processOneOrder(store, order, orderId) {
  const channel = order.source || 'POS';
  let result = null;

  try {
    if (order.orderState === 'COMPLETED') {
      await knex.transaction(async (trx) => {
        result = { kind: 'complete', ...(await ingestCompletedOrder(trx, store, order, channel)) };
      });
    } else if (order.orderState === 'CANCELLED') {
      await knex.transaction(async (trx) => {
        result = { kind: 'cancel', ...(await reverseCancelledOrder(trx, store, order)) };
      });
    } else {
      // orderStates 파라미터를 생략해 API 기본값(COMPLETED/CANCELLED)에 기대고 있으므로 이 분기는
      // 정상 흐름에서는 안 타야 한다. 혹시 다른 상태값이 섞여 오면(API 응답 변경 등) 어설프게
      // COMPLETED로 취급해 재고를 잘못 깎느니, 건너뛰고 눈에 띄게 로그를 남기는 편이 안전하다.
      console.warn(`[동기화][토스] 처리 대상이 아닌 orderState="${order.orderState}" (orderId=${orderId}) — 건너뜁니다`);
      return { inserted: 0, failed: 0, skipped: 1 };
    }
  } catch (e) {
    // 한 주문 처리 실패(예: menuResolver의 순환 참조 감지, DB 일시 오류)가 나머지 주문/가맹점
    // 처리를 막으면 안 된다 — SYNC_FAILED는 "가맹점 동기화 자체의 연속 실패"를 감지하는 용도라
    // 더 크고(index.js), 이건 그보다 세밀한 "주문 한 건" 단위 실패라 로그로 충분하다. 다만 이 건은
    // 실패로 집계해서 호출부가 last_synced_at을 밀지 않고 다음 창에서 재시도하게 한다.
    console.error(`[동기화][토스] 주문 처리 실패 (orderId=${orderId}):`, e.message);
    return { inserted: 0, failed: 1, skipped: 0 };
  }

  // broadcast()/createRisk()는 되돌릴 수 없는 외부 부수효과라 트랜잭션 밖(커밋 후)에서 호출해야
  // 한다 — 트랜잭션이 롤백되면 "실제로는 일어나지 않은 재고부족/리스크"를 알리게 되기 때문
  // (webhook.js와 동일한 이유, 동일한 패턴). createRisk는 knex(비트랜잭션 커넥션)를 쓰므로
  // 트랜잭션이 끝난 뒤에만 호출해야 교착을 피한다(CLAUDE.md 4절).
  if (result.lowStockAlert) broadcast(result.lowStockAlert);
  await emitRiskNotifications(store, result.issues);

  // 이미 CANCELLED로 반영된 주문이 폴링 창 안에서 다시 COMPLETED로 보이는 경우(재유입) —
  // ingestCompletedOrder가 이를 감지해 반환하는 skipped 플래그를 그대로 집계에 반영한다.
  // (reverseCancelledOrder는 {reversed, issues}만 반환하고 skipped를 쓰지 않으므로 취소 경로에서는
  // 항상 undefined라 이 분기를 타지 않고, 아래 kind==='complete' 분기에서도 걸러진다.)
  if (result.skipped) return { inserted: 0, failed: 0, skipped: 1 };

  if (result.kind === 'complete' && result.applied) {
    // 라인아이템 수를 돌려주고 있어 화면의 'N건 반영'이 실제 주문 건수와 달랐다(Stores.jsx의
    // 일괄 동기화 결과표). 이 값의 소비자는 전부 '주문 몇 건'을 기대한다.
    return { inserted: 1, failed: 0, skipped: 0 };
  }
  return { inserted: 0, failed: 0, skipped: 0 };
}

async function syncStoreSales(store, fromTs, toTs) {
  const accessKey = process.env.TOSS_PLACE_ACCESS_KEY;
  const secretKey = process.env.TOSS_PLACE_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('TOSS_PLACE_ACCESS_KEY / TOSS_PLACE_SECRET_KEY 환경변수가 설정되지 않았습니다');
  if (!store.toss_store_id) throw new Error('토스플레이스 매장 ID(toss_store_id)가 설정되지 않았습니다');

  const TOSS_BASE = process.env.TOSS_PLACE_API_URL || 'https://open-api.tossplace.com';
  // 호출부(index.js)가 이미 epoch ms로 계산해서 넘겨준다 — 여기서는 하한선 클램프만 한다.
  if (fromTs < TOSS_PLACE_MIN_TS) fromTs = TOSS_PLACE_MIN_TS;
  // toTs가 fromTs보다 과거면(호출부 계산 오류 등) API에 잘못된 구간을 보내느니 빈 결과로 즉시 반환한다.
  if (toTs < fromTs) return { inserted: 0, failed: 0, skipped: 0, total: 0 };

  let page = 1;
  let inserted = 0;
  let failed = 0;
  let skipped = 0;
  // 네트워크가 멈추거나 토스 쪽이 같은 페이지를 반복 응답하는 등의 이상 상황에서
  // while(true)가 영원히 끝나지 않아 화면이 "동기화 중..."에 멈춘 것처럼 보이는 문제를 막기 위한 안전장치
  const MAX_PAGES = 2000;

  while (true) {
    if (page > MAX_PAGES) {
      throw new Error(`페이지 수가 ${MAX_PAGES}을 초과했습니다 — 토스플레이스 응답이 비정상적으로 반복되는 것으로 보입니다. 기간을 줄여서 다시 시도해주세요`);
    }

    // orderStates 파라미터는 일부러 생략한다. 토스 문서 기준 이 API의 orderStates는 배열 파라미터이고
    // 기본값이 ["COMPLETED","CANCELLED"] 둘 다인데, 예전 코드는 굳이 orderStates=COMPLETED로 좁혀놔서
    // 취소된 주문이 다시 내려오지 않았다(취소돼도 원래 반영된 재고/매출이 영원히 안 고쳐짐). 배열
    // 파라미터를 쿼리스트링에 어떻게 넣어야 하는지(반복 키 orderStates=A&orderStates=B 인지, 콤마
    // 구분인지)는 실제 토스 API를 호출해 확인하기 전에는 확신할 수 없고, 이번 작업 범위에서는 실제
    // API 호출이 금지되어 있다(운영 데이터 영향 우려) — 잘못된 형식으로 넣으면 최악의 경우 API가
    // 이를 무시하고 자체 기본값을 쓰거나, 반대로 빈 배열로 해석해 아무 주문도 안 내려줄 수 있어
    // 검증 없이 형식을 추측하는 것 자체가 위험하다. 파라미터를 아예 생략하면 "무엇을 보내야 하는가"라는
    // 질문 자체가 사라지고 문서화된 기본 동작(COMPLETED+CANCELLED 둘 다)을 그대로 받는다 — from/to가
    // "결제 내역이 변동된 시각" 기준이라는 점과 맞물려 우리가 원하는 동작과 정확히 일치한다.
    const url = `${TOSS_BASE}/api-public/openapi/v1/merchants/${store.toss_store_id}/order/orders`
      + `?from=${fromTs}&to=${toTs}&page=${page}&size=100`;

    console.log(`[동기화][토스] ${url}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let resp;
    try {
      resp = await fetch(url, { headers: { 'x-access-key': accessKey, 'x-secret-key': secretKey }, signal: controller.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`토스플레이스 API 응답이 20초 내에 오지 않았습니다 (page=${page})`);
      throw e;
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Toss Place API 오류 (${resp.status}): ${txt}`);
    }

    const data = await resp.json();
    // 응답이 배열이거나 { orders: [...] } 구조 모두 처리
    // 실제 토스플레이스 응답: { resultType: "SUCCESS", success: [...] }
    const orders = Array.isArray(data) ? data : (data.success || data.orders || data.content || data.data || []);
    console.log(`[동기화][토스] page=${page} ${orders.length}건 수신, 누적 ${inserted}건 반영됨`);

    for (const order of orders) {
      const rawId = order.id ?? order.orderId;
      if (rawId === undefined || rawId === null || String(rawId).trim() === '') {
        // 예전엔 String(undefined) = "undefined" 문자열이 되어, id가 빠진 주문이 오는 매장마다
        // 전 가맹점이 toss_order_id="undefined" 한 행을 공유했다. skipped로 세면 last_synced_at이
        // 그대로 밀려 그 구간이 유실된다.
        console.error(`[동기화][토스] 주문 식별자(id/orderId)가 없는 주문을 건너뜁니다 (store=${store.id})`);
        failed += 1;
        continue;
      }
      const orderId = String(rawId);
      // order.createdAt이 없으면(비정상 응답 등) 검색 구간 시작점을 판매시각으로 대신 쓴다 — "지금"을
      // 쓰면 실제로는 fromDate~toDate 사이에 있었던 판매가 매번 동기화 시점 시각으로 덮어써져
      // 날짜별 매출 집계가 흔들린다.
      const soldAt = order.createdAt ? new Date(order.createdAt).toISOString()
        : new Date(fromTs).toISOString();
      // 배달앱 연동을 켠 매장은 배민/쿠팡이츠/요기요 주문도 여기 같이 들어오고, order.source에
      // 출처가 표시된다. 값이 없으면 매장에서 직접 받은 주문(POS)으로 간주
      const normalizedOrder = { ...order, id: orderId, createdAt: soldAt };

      // 주문 하나당 하나의 트랜잭션(processOneOrder 내부)으로 묶어, 한 건이 실패해도(예: 레시피
      // 순환 참조, 일시적 DB 오류) 나머지 주문과 다음 페이지 처리가 계속되게 한다 — 예전처럼 이
      // 루프 전체를 하나의 실패로 막으면, 페이지 뒤쪽의 정상 주문들까지 이번 동기화에서 통째로
      // 누락된다.
      const r = await processOneOrder(store, normalizedOrder, orderId);
      inserted += r.inserted;
      failed += r.failed;
      skipped += r.skipped;
    }

    if (orders.length < 100) break;
    page++;
  }

  return { inserted, failed, skipped, total: inserted + failed + skipped };
}

module.exports = { isConfigured, syncStoreSales, labelFor, kstDayStartTs, kstDayEndTs };
