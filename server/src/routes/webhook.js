const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { knex } = require('../db/schema');
const { broadcast } = require('./sse');
const { getOrderNode } = require('../orderFinance');
const { RISK_TYPES, RISK_SEVERITIES } = require('../constants');
const { decryptCredential } = require('../crypto');
// createRisk는 내부에서 knex(트랜잭션이 아닌 커넥션)를 직접 쓴다 — SQLite는 커넥션 풀이 1개뿐이라
// 이미 열린 트랜잭션(trx) 안에서 호출하면 서로 커넥션을 기다리며 교착 상태에 빠진다. 그래서 이
// 파일에서는 트랜잭션 안에서는 아무것도 알리지 않고, 트랜잭션이 커밋된 뒤에만 createRisk(또는
// emitRiskNotifications)를 호출한다 (broadcast()와 동일한 이유, 동일한 패턴).
const { createRisk } = require('./risks');
// 주문 하나를 실제로 반영/취소하는 로직(재고 차감/복구, sales_items 적립, 리스크 알림 판단)은
// salesIngest.js 하나로 통일되어 있다 — 웹훅과 폴링(channels/toss.js)이 똑같은 코드를 타야 재고가
// 두 경로에서 서로 다르게 계산되는 사고가 안 생긴다. 이 파일은 이제 "라우팅 + 서명 검증 + 웹훅
// 페이로드를 order 객체로 풀어내는" 어댑터 역할만 한다.
const { ingestCompletedOrder, reverseCancelledOrder, emitRiskNotifications } = require('../salesIngest');

// /webhook/*는 rate limit 면제 경로(토스 재시도가 429로 막히면 매출이 유실되므로)라, 시크릿이 없는
// 매장 ID로 요청을 반복하면 서명 검증 전에 createRisk가 매번 DB 쓰기를 한다 — 인증 없이 DB를
// 두드릴 수 있는 경로가 된다. 같은 매장에 대해서는 10분에 한 번만 알린다(어차피 createRisk가
// (브랜드,가맹점,타입) 단위로 중복을 흡수하므로 알림 내용에는 손실이 없다).
const WEBHOOK_REJECT_COOLDOWN_MS = 10 * 60 * 1000;
const lastRejectAlertAt = new Map(); // store_id -> ts

// 웹훅의 "생성" 이벤트 페이로드는 { data: { order: {...} } } 형태로 감싸져 오는 게 기본이지만,
// 예전 페이로드 중에는 { data: { orderId, createdAt, lineItems } }처럼 order로 한 번 더 감싸지 않은
// 형태도 있었다(레거시). id/createdAt/lineItems 세 필드 모두 "감싸진 형태 우선, 아니면 한 단계 위,
// 그래도 없으면 최종 기본값" 순서로 각각 독립적으로 폴백한다 — salesIngest.ingestCompletedOrder가
// 기대하는 정규화된 order 객체(id, createdAt, lineItems가 최상위에 있는 형태, orderFinance.js
// getOrderNode의 결과와 동일한 모양)로 맞춰준다.
function unwrapCreatedOrder(payload) {
  const dataOrder = payload.data && payload.data.order;
  const orderId = (dataOrder && dataOrder.id)
    || (payload.data && payload.data.orderId)
    || payload.id
    || `manual_${Date.now()}`;
  const createdAt = (dataOrder && dataOrder.createdAt)
    || (payload.data && payload.data.createdAt)
    || new Date().toISOString();
  const lineItems = (dataOrder && dataOrder.lineItems)
    || (payload.data && payload.data.lineItems)
    || [];
  // chargePrice/payments/orderState 등 금액 필드는 orderFinance.js의 getOrderNode 규칙(payload.data.order
  // 우선, 없으면 payload 자체)을 그대로 따른다 — extractOrderFinance(payload)를 직접 부르던 예전과
  // 동일한 값이 나와야 하므로, 여기서 만드는 order 객체에도 그 필드들을 그대로 얹어 넘긴다.
  const financeNode = getOrderNode(payload) || {};
  return { ...financeNode, id: orderId, createdAt, lineItems };
}

async function handleWebhook(req, res, store) {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
    const payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody) : req.body;

    // 시크릿키 검증: 가맹점별로 등록한 webhook_secret을 우선 사용 (가맹점관리 화면에서 설정하는 값이
    // 실제로는 전혀 안 쓰이고 환경변수 하나로만 검증하던 문제 — store_id만 알면(URL에 그대로 노출됨)
    // 누구나 서명 없이 가짜 주문/취소 이벤트를 보내 재고·매출을 조작할 수 있었음). 과거 호환을 위해
    // 가맹점에 시크릿이 없으면 전역 환경변수로 폴백
    // DB에는 CREDENTIALS_KEY 설정 여부/마이그레이션 시점에 따라 평문·암호문이 섞여 있을 수 있다.
    // decryptCredential이 접두사로 스스로 판별해 평문이면 그대로, 암호문이면 복호화해서 돌려준다 —
    // 이 경로가 깨지면 정상 시크릿을 가진 가맹점의 웹훅까지 전부 401이 되어 매출이 안 들어온다.
    const secret = decryptCredential(store.webhook_secret) || process.env.TOSS_WEBHOOK_SECRET;
    // 시크릿이 아예 없으면 검증을 건너뛰던 게 진짜 구멍이었음 — 신규 가맹점은 기본값이 빈 문자열이라
    // 시크릿을 설정하기 전까지 서명 없이 아무 요청이나 받아들이게 됨. 설정 누락은 대부분 공격이 아니라
    // 운영 실수이므로, 조용히 401만 내려주면 원인 파악이 어려워 경고 로그를 남기고 거부한다
    if (!secret) {
      console.warn(`[웹훅] 가맹점(${store.name}, id=${store.id})에 webhook_secret이 설정되지 않아 요청을 거부했습니다.`);
      // 이 가맹점의 매출이 통째로 안 들어온다는 뜻인데 로그만 남으면 직접 로그를 보지 않는 한 아무도
      // 모른다. 트랜잭션 밖이라 바로 createRisk를 호출해도 교착 위험이 없다. 알림 생성 실패가
      // 401 응답 자체를 막으면 안 되므로 감싼다.
      const now = Date.now();
      const lastAt = lastRejectAlertAt.get(store.id);
      if (!lastAt || now - lastAt >= WEBHOOK_REJECT_COOLDOWN_MS) {
        lastRejectAlertAt.set(store.id, now);
        // Map이 무한히 커지지 않도록(시크릿 없는 매장 ID를 계속 바꿔가며 두드리는 경우 대비) 주기적으로
        // 쿨다운이 지난 항목을 정리한다.
        if (lastRejectAlertAt.size > 5000) {
          for (const [sid, ts] of lastRejectAlertAt) {
            if (now - ts >= WEBHOOK_REJECT_COOLDOWN_MS) lastRejectAlertAt.delete(sid);
          }
        }
        try {
          await createRisk(store.brand_id, store.id, RISK_TYPES.WEBHOOK_REJECTED, RISK_SEVERITIES.HIGH,
            `웹훅 시크릿 미설정: 가맹점 "${store.name}"의 매출 웹훅이 거부되고 있습니다 — webhook_secret 등록 필요`,
            { store_id: store.id, store_name: store.name });
        } catch (e) {
          console.error('[웹훅] WEBHOOK_REJECTED 리스크 알림 생성 실패:', e);
        }
      }
      return res.sendStatus(401);
    }

    const signature = req.headers['x-toss-signature'] || '';
    const timestamp = req.headers['x-toss-timestamp'] || '';
    if (!signature || !timestamp) return res.sendStatus(401);

    // 타임스탬프가 초/밀리초 단위 모두 올 수 있어 둘 다 처리, 5분 이상 차이나면 재전송 공격으로 간주해 거부
    const tsNum = Number(timestamp);
    const tsMs = tsNum < 10_000_000_000 ? tsNum * 1000 : tsNum;
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
      return res.sendStatus(401);
    }

    const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    const expected = `v1=${hmac}`;
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return res.sendStatus(401);
    }

    const type = payload.type || '';
    console.log(`[웹훅] 가맹점(${store.name}) 수신:`, type);

    if (!type.startsWith('order.order.')) return res.sendStatus(200);

    // ── 주문 취소 ──────────────────────────────────────
    if (type === 'order.order.cancelled.v1') {
      const cancelledOrderId = payload.data && payload.data.orderId;
      if (!cancelledOrderId) return res.sendStatus(200);

      // 재고 복구 + sales_items 삭제 + orders 상태 변경(reverseCancelledOrder 내부)을 하나의
      // 트랜잭션으로 묶는다. 셋 중 하나만 반영되면(특히 orders update가 빠지면) 매출 집계가
      // 영구히 어긋난 채로 남는다.
      let result;
      await knex.transaction(async (trx) => {
        result = await reverseCancelledOrder(trx, store, { id: cancelledOrderId });
      });
      // createRisk는 knex(비트랜잭션 커넥션)를 쓰므로 트랜잭션이 끝난 뒤에만 호출해야 한다(교착 방지).
      await emitRiskNotifications(store, result.issues);
      console.log('[웹훅] 취소 처리 완료:', cancelledOrderId, result.reversed ? '(재고 복구됨)' : '(반영 이력 없어 재고 변동 없음)');
      return res.sendStatus(200);
    }

    // ── 주문 생성 ──────────────────────────────────────
    if (type === 'order.order.created.v1') {
      const order = unwrapCreatedOrder(payload);

      // orders insert부터 sales_items 적립, 재고 차감, alert_log 기록까지(ingestCompletedOrder
      // 내부) 전부 하나의 트랜잭션으로 묶는다. 그렇지 않으면 "주문은 저장됐는데 재고는 안 깎임"
      // 같은 어긋난 상태가 남는다. 이미 이 주문 id로 반영된 적이 있으면(웹훅 재전송 등)
      // ingestCompletedOrder가 스스로 재고 재차감을 건너뛴다 — 이 파일은 그 판단에 관여하지 않는다.
      let result;
      await knex.transaction(async (trx) => {
        result = await ingestCompletedOrder(trx, store, order, 'POS');
      });

      // broadcast()/createRisk()는 되돌릴 수 없는 외부 부수효과라 트랜잭션 밖(커밋 후)에서 호출해야
      // 한다 — 트랜잭션이 롤백되면 "실제로는 일어나지 않은 재고부족/리스크"를 알리게 되기 때문.
      if (result.lowStockAlert) broadcast(result.lowStockAlert);
      await emitRiskNotifications(store, result.issues);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
}

// 가맹점별 웹훅: /webhook/:storeId (숫자 ID만 허용 — 가맹점명 조회는 URL만 보고도 특정 가맹점을
// 노려 공격하기 쉽고, 이름이 중복되면 엉뚱한 가맹점이 매칭될 수 있어 제거했다. 토스 웹훅 URL은
// 운영자가 등록하는 값이므로 ID로 통일해도 문제 없음)
router.post('/:storeId', express.raw({ type: 'application/json' }), async (req, res) => {
  const param = req.params.storeId;
  if (!/^\d+$/.test(param)) return res.sendStatus(404);
  const store = await knex('stores').where({ id: param }).first();
  if (!store) return res.sendStatus(404);
  await handleWebhook(req, res, store);
});

module.exports = router;
