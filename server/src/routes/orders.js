const createAsyncRouter = require('../middleware/asyncRouter');
const router = createAsyncRouter();
const { knex } = require('../db/schema');
const { requireAuth, requireRole, LOGISTICS_ROLES, HQ_ROLES, STORE_ROLES } = require('../middleware/auth');

function isStoreRole(role) {
  return ['STORE_OWNER', 'STORE_STAFF'].includes(role);
}
const { createRisk, getRiskSettings } = require('./risks');
const { logAudit } = require('../auditLog');
const { logStockMovement } = require('../stockLedger');
const { ORDER_STATUSES, PAYMENT_STATUSES, RISK_TYPES, RISK_SEVERITIES, PURCHASE_ORDER_ITEM_STATUSES, STOCK_LEDGER_TYPES } = require('../constants');
const { canTransition } = require('../orderStatusFlow');
const { dbTimeAgo } = require('../dbTime');
const crypto = require('crypto');

const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';
const TOSS_API_BASE = 'https://api.tosspayments.com/v1/payments';

// PAYMENT_PENDING은 paid_at이 없을 때만 허용 — 가맹점 화면(StoreOrder.jsx)의 '발주 취소' 버튼이
// 이 상태에서 뜬다. 결제 완료 이후는 cancelBlockReason의 paid_at 검사가 따로 막는다.
const CANCELABLE_STATUSES = [ORDER_STATUSES.DRAFT, ORDER_STATUSES.ORDERED, ORDER_STATUSES.REVIEWING, ORDER_STATUSES.REVISION_REQUESTED, ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.PAYMENT_PENDING];

// 취소 가능 여부 판정 — 차단 목록(blocklist) 방식이라 PAYMENT_PENDING/PREPARING_SHIPMENT가 빠져 있었고,
// 결제 완료(paid_at 존재) 발주서를 환불 없이 CANCELED로 만들 수 있었다. 정산(/settlement)은 paid_at
// 기준이라 그 건이 계속 매출로 잡힌 채 남는다. 반환: null이면 취소 가능, 문자열이면 그대로 400 응답 메시지.
function cancelBlockReason(order) {
  if (!CANCELABLE_STATUSES.includes(order.status)) return `취소할 수 없는 상태입니다 (현재: ${order.status})`;
  if (order.paid_at) return '결제가 완료된 발주서는 취소할 수 없습니다. 환불로 처리해주세요';
  return null;
}

async function checkSalesDownOrderUp(brand_id, store_id) {
  // orders.processed_at은 ISO 문자열 그대로 비교 (토스 동기화 쪽 저장 포맷과 맞춤)
  const fourteenAgoIso = new Date(Date.now() - 14 * 86400000).toISOString();
  const sevenAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
  // purchase_orders.created_at은 DB 기본값(knex.fn.now())과 같은 포맷이어야 방언별 비교가 어긋나지 않는다
  const fourteenAgo = dbTimeAgo(14 * 86400000);
  const sevenAgo = dbTimeAgo(7 * 86400000);

  // 최근 14일 vs 7일 주문 건수 비교 (POS 판매)
  const older = await knex('orders').where({ brand_id, store_id }).where('processed_at', '>=', fourteenAgoIso).where('processed_at', '<', sevenAgoIso).count('id as cnt').first();
  const recent = await knex('orders').where({ brand_id, store_id }).where('processed_at', '>=', sevenAgoIso).count('id as cnt').first();

  const olderCnt = Number(older?.cnt || 0);
  const recentCnt = Number(recent?.cnt || 0);

  // 최근 7일 발주 금액
  const recentOrder = await knex('purchase_orders')
    .where({ brand_id, store_id }).whereNotIn('status', [ORDER_STATUSES.DRAFT, ORDER_STATUSES.CANCELED])
    .where('created_at', '>=', sevenAgo).sum('total_amount as total').first();
  const prevOrder = await knex('purchase_orders')
    .where({ brand_id, store_id }).whereNotIn('status', [ORDER_STATUSES.DRAFT, ORDER_STATUSES.CANCELED])
    .where('created_at', '>=', fourteenAgo).where('created_at', '<', sevenAgo).sum('total_amount as total').first();

  const recentOrderAmt = Number(recentOrder?.total || 0);
  const prevOrderAmt = Number(prevOrder?.total || 0);

  // 매출 감소 & 발주 증가 — 본사가 설정한 비율 기준
  const settings = await getRiskSettings(brand_id);
  if (olderCnt > 0 && recentCnt < olderCnt * settings.salesDropRatio && prevOrderAmt > 0 && recentOrderAmt > prevOrderAmt * settings.orderSpikeRatio) {
    await createRisk(brand_id, store_id, RISK_TYPES.SALES_DOWN_ORDER_UP, RISK_SEVERITIES.HIGH,
      `매출 감소·발주 증가: 판매 ${olderCnt}건→${recentCnt}건, 발주 ${Math.round(prevOrderAmt).toLocaleString()}원→${Math.round(recentOrderAmt).toLocaleString()}원`,
      { older_sales: olderCnt, recent_sales: recentCnt, prev_order: prevOrderAmt, recent_order: recentOrderAmt }
    );
  }
}

// 가맹점의 발주 마감시간(HH:MM, 한국시간 기준)이 지났는지 확인 — 임시저장(submit=false)에는 적용 안 함
function isPastOrderDeadline(deadline) {
  if (!deadline) return false;
  const kstNow = new Date(Date.now() + 9 * 3600000);
  const hh = String(kstNow.getUTCHours()).padStart(2, '0');
  const mm = String(kstNow.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}` > deadline;
}

// 예전엔 product_id가 없는 라인에 한해 클라이언트 unit_price를 그대로 믿었는데, 음수 단가 라인을
// 하나 섞으면 total_amount가 줄고 그 값이 그대로 결제 승인 금액이 됐다(30만원 발주를 1만원에 승인시키는
// 것이 실제로 재현됨). 자유 단가 경로 자체를 없앤다 — 모든 항목은 반드시 이 브랜드의 등록 상품이어야 하고,
// unit_price/unit은 항상 서버 상품 값으로 덮어쓴다.
// 반환: { items, error }. product_id가 없거나 이 브랜드 상품이 아니면 error를 채워 돌려준다.
async function resolveItemPrices(brand_id, items) {
  const ids = items.map(i => i.product_id).filter(Boolean);
  if (ids.length !== items.length) {
    return { items: null, error: '등록된 발주 상품만 담을 수 있습니다' };
  }
  const products = await knex('products').where({ brand_id }).whereIn('id', ids);
  const byId = new Map(products.map(p => [p.id, p]));
  const resolved = [];
  for (const item of items) {
    const product = byId.get(Number(item.product_id));
    if (!product) {
      return { items: null, error: `${item.product_name || '상품'}은(는) 등록된 발주 상품이 아닙니다` };
    }
    // 단종(is_active=false) 상품이 카탈로그에서 사라져도 템플릿/재주문 경로로는 계속 발주됐다.
    // PUT /:id는 전체 items를 이 함수로 재검증하므로, 단종 상품이 담긴 DRAFT는 수정(자동저장 포함) 시에도
    // 거부된다 — 새 항목 추가만 막는 게 아니다. 이 경우 사용자는 해당 항목을 빼야 저장할 수 있다.
    if (!product.is_active) {
      return { items: null, error: `${product.name}은(는) 현재 발주할 수 없는 상품입니다` };
    }
    resolved.push({ ...item, unit_price: product.price, unit: product.unit });
  }
  return { items: resolved, error: null };
}

// 클라이언트를 신뢰하지 않고 서버에서 다시 한번 항목 유효성을 검증
function validateOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '발주 항목이 비어있습니다';
  }
  if (items.length > 200) {
    return '발주 항목은 200개를 넘을 수 없습니다';
  }
  for (const item of items) {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return `${item.product_name || '상품'}의 수량이 올바르지 않습니다`;
    }
    if (qty > 100000) {
      return `${item.product_name || '상품'}의 수량이 너무 큽니다`;
    }
  }
  return null;
}

async function logHistory(order_id, action, before, after, reason, user_id, item_id = null, reason_code = null) {
  await knex('order_history').insert({
    order_id, item_id,
    changed_by: user_id || null,
    action,
    before_value: before ? JSON.stringify(before) : null,
    after_value: after ? JSON.stringify(after) : null,
    reason: reason || null,
    reason_code: reason_code || null,
  });
}

// 본사가 수량조정/품절처리/수정요청을 했을 때, 가맹점이 화면에 들어가야만 알 수 있던 문제를 없애기 위해
// 다음에 가맹점이 들어오면 바로 보이도록 플래그를 세운다
async function flagNeedsAttention(order_id, note) {
  await knex('purchase_orders').where({ id: order_id }).update({ needs_attention: true, attention_note: note });
}

// ── 발주서 목록 ───────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const { status, store_id } = req.query;
  const q = knex('purchase_orders as po')
    .join('stores as s', 'po.store_id', 's.id')
    .leftJoin('users as u', 'po.created_by', 'u.id')
    .leftJoin('users as au', 's.assigned_user_id', 'au.id')
    .select('po.*', 's.name as store_name', 'u.name as created_by_name', 'au.name as assigned_user_name')
    .where('po.brand_id', req.user.brand_id)
    .orderBy('po.created_at', 'desc');

  if (status) q.where('po.status', status);
  if (store_id) q.where('po.store_id', store_id);
  // 가맹점 역할은 본인 가맹점만
  if (['STORE_OWNER', 'STORE_STAFF'].includes(req.user.role)) {
    q.where('po.store_id', req.user.store_id);
  }
  // 3중 조인 전체 조회라 발주가 쌓이면 한 요청이 프로세스 메모리를 통째로 먹는다. 정식 페이지네이션은
  // API 계약 변경이라 이번 범위 밖 — 우선 상한만 둔다. 기본값을 더 낮추면 데이터가 조용히 잘려 더 나쁘다.
  q.limit(Math.min(Number(req.query.limit) || 2000, 2000));
  res.json(await q);
});

// 가맹점이 모르고 지나치면 안 되는, 본사가 손댄 발주서 목록 (수량조정/품절/대체/수정요청)
router.get('/attention', requireAuth, async (req, res) => {
  if (!isStoreRole(req.user.role) || !req.user.store_id) return res.json([]);
  const rows = await knex('purchase_orders')
    .where({ brand_id: req.user.brand_id, store_id: req.user.store_id, needs_attention: true })
    .orderBy('updated_at', 'desc');
  res.json(rows);
});

router.post('/:id/ack', requireAuth, async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (isStoreRole(req.user.role) && order.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '권한 없음' });
  }
  await knex('purchase_orders').where({ id: order.id }).update({ needs_attention: false });
  res.json({ ok: true });
});

// 가맹점이 신고했지만 본사가 아직 처리 안 한 검수 이상 목록
router.get('/receipt-issues', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const rows = await knex('purchase_orders as po')
    .join('stores as s', 'po.store_id', 's.id')
    .select('po.id', 'po.store_id', 's.name as store_name', 'po.receipt_issue_note', 'po.updated_at')
    .where('po.brand_id', req.user.brand_id)
    .whereNotNull('po.receipt_issue_note')
    .whereNull('po.receipt_issue_resolved_at')
    .orderBy('po.updated_at', 'desc');
  res.json(rows);
});

// 환불 사유 집계 (최근 N일) — 반드시 '/:id'보다 먼저 등록해야 한다. express는 등록 순서대로 매칭하므로
// 뒤에 두면 '/:id'가 'refund-reasons' 문자열을 삼켜 SQLite에서 404, Postgres에서 500이 난다
// ('/receipt-issues'가 같은 이유로 앞에 있다)
router.get('/refund-reasons', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const days = Number(req.query.days) || 30;
  // order_history 자체에는 brand_id가 없어(발주서에만 있음) purchase_orders를 조인해 브랜드로 좁히지 않으면
  // 다른 브랜드의 환불 사유까지 한 통계에 섞여 들어간다.
  const rows = await knex('order_history')
    .join('purchase_orders as po', 'order_history.order_id', 'po.id')
    .where('po.brand_id', req.user.brand_id)
    .whereNotNull('order_history.reason_code')
    .where('order_history.created_at', '>=', dbTimeAgo(days * 86400000))
    .select('order_history.reason_code')
    .count('order_history.id as count')
    .groupBy('order_history.reason_code')
    .orderBy('count', 'desc');
  res.json(rows.map(r => ({ reason_code: r.reason_code, count: Number(r.count) })));
});

// ── 발주서 상세 ───────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const order = await knex('purchase_orders as po')
    .join('stores as s', 'po.store_id', 's.id')
    .leftJoin('users as u', 'po.created_by', 'u.id')
    .leftJoin('users as au', 's.assigned_user_id', 'au.id')
    .select('po.*', 's.name as store_name', 'u.name as created_by_name', 'au.name as assigned_user_name')
    .where('po.id', req.params.id)
    .where('po.brand_id', req.user.brand_id)
    .first();
  if (!order) return res.status(404).json({ error: '발주서 없음' });
  if (isStoreRole(req.user.role) && order.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '권한 없음' });
  }

  const items = await knex('purchase_order_items').where({ order_id: order.id });
  const history = await knex('order_history as h')
    .leftJoin('users as u', 'h.changed_by', 'u.id')
    .select('h.*', 'u.name as changed_by_name')
    .where('h.order_id', order.id)
    .orderBy('h.created_at', 'desc');

  res.json({ ...order, items, history });
});

// ── 발주서 생성 (임시저장 or 발주완료) ────────────────
router.post('/', requireAuth, async (req, res) => {
  const store_id = req.user.store_id;
  if (!store_id) return res.status(400).json({ error: '가맹점 정보 없음' });

  const { memo, submit } = req.body;
  if (submit) {
    const store = await knex('stores').where({ id: store_id }).first();
    if (isPastOrderDeadline(store?.order_deadline)) {
      return res.status(400).json({ error: `발주 마감시간(${store.order_deadline})이 지났습니다. 임시저장만 가능합니다` });
    }
  }

  const itemError = validateOrderItems(req.body.items);
  if (itemError) return res.status(400).json({ error: itemError });

  const { items, error } = await resolveItemPrices(req.user.brand_id, req.body.items);
  if (error) return res.status(400).json({ error });
  // 금액은 항상 정수(원) 단위로 반올림 — float 곱셈에서 생기는 소수점 오차가 환불/정산 계산까지
  // 누적되는 것을 막기 위함
  const total = Math.round(items.reduce((s, i) => s + (i.unit_price * i.quantity), 0));
  const status = submit ? ORDER_STATUSES.ORDERED : ORDER_STATUSES.DRAFT;

  let id;
  await knex.transaction(async (trx) => {
    const [row] = await trx('purchase_orders').insert({
      brand_id: req.user.brand_id,
      store_id,
      created_by: req.user.id,
      status, total_amount: total, memo,
      ordered_at: submit ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).returning('id');
    id = row.id;

    await trx('purchase_order_items').insert(items.map(item => ({
      order_id: id,
      product_id: item.product_id || null,
      product_name: item.product_name,
      unit: item.unit,
      unit_price: item.unit_price || 0,
      quantity: item.quantity,
      amount: Math.round((item.unit_price || 0) * item.quantity),
    })));
  });

  await logHistory(id, 'CREATED', null, { status }, null, req.user.id);

  // 발주 시 매출감소·발주증가 리스크 체크 (비동기)
  if (submit) {
    checkSalesDownOrderUp(req.user.brand_id, store_id).catch(() => {});
  }

  res.json({ id });
});

// ── 발주서 수정 (임시저장 상태에서만) ─────────────────
router.put('/:id', requireAuth, async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (isStoreRole(req.user.role) && order.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '권한 없음' });
  }
  if (![ORDER_STATUSES.DRAFT, ORDER_STATUSES.REVISION_REQUESTED].includes(order.status)) {
    return res.status(400).json({ error: '수정 불가 상태' });
  }
  // 같은 발주서를 다른 직원이 먼저 수정한 경우, 화면에 보고 있던 시점 이후 변경됐다면 덮어쓰지 않고 알림
  if (req.body.updated_at && order.updated_at &&
      new Date(req.body.updated_at).getTime() !== new Date(order.updated_at).getTime()) {
    return res.status(409).json({ error: '다른 직원이 먼저 이 발주서를 수정했습니다. 새로고침 후 다시 시도해주세요' });
  }
  if (req.body.submit) {
    const store = await knex('stores').where({ id: order.store_id }).first();
    if (isPastOrderDeadline(store?.order_deadline)) {
      return res.status(400).json({ error: `발주 마감시간(${store.order_deadline})이 지났습니다. 임시저장만 가능합니다` });
    }
  }

  const itemError = validateOrderItems(req.body.items);
  if (itemError) return res.status(400).json({ error: itemError });

  const { items, error } = await resolveItemPrices(req.user.brand_id, req.body.items);
  if (error) return res.status(400).json({ error });
  const { memo, submit } = req.body;
  const total = Math.round(items.reduce((s, i) => s + (i.unit_price * i.quantity), 0));
  const status = submit ? ORDER_STATUSES.ORDERED : order.status;
  const nowIso = new Date().toISOString();

  await knex.transaction(async (trx) => {
    // 품목 행을 전부 delete/insert로 갈아끼우므로 본사가 넣었던 confirmed_quantity/status/substitute_note가
    // 함께 사라진다. 그런데 confirmed_amount만 남으면 payment/prepare·payment/confirm의
    // confirmed_amount ?? total_amount가 옛 확정금액으로 결제를 잡는다(10박스 확정 5박스=50,000 →
    // 수정요청 → 20박스 재제출 200,000 → 결제 50,000이 실제로 재현됨). 이어하기 화면을 열기만 해도
    // 자동저장이 이 PUT을 쏘므로 본사 조정이 전부 지워진 채 금액만 살아남는다. 재계산이 아니라 null
    // 리셋인 이유: 본사가 다시 검토·확정해야 하는 상태이기 때문.
    await trx('purchase_orders').where({ id: order.id }).update({
      status, total_amount: total, memo, confirmed_amount: null,
      ordered_at: submit && !order.ordered_at ? nowIso : order.ordered_at,
      updated_at: nowIso,
    });
    await trx('purchase_order_items').where({ order_id: order.id }).delete();
    for (const item of items) {
      await trx('purchase_order_items').insert({
        order_id: order.id,
        product_id: item.product_id || null,
        product_name: item.product_name,
        unit: item.unit,
        unit_price: item.unit_price || 0,
        quantity: item.quantity,
        amount: Math.round((item.unit_price || 0) * item.quantity),
      });
    }
  });
  await logHistory(order.id, 'UPDATED', { status: order.status }, { status }, null, req.user.id);
  res.json({ ok: true, updated_at: nowIso });
});

// ── 상태 변경 (본사용) ────────────────────────────────
router.post('/:id/status', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const { status, reason } = req.body;
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (!Object.values(ORDER_STATUSES).includes(status)) return res.status(400).json({ error: '알 수 없는 상태 값입니다' });
  if (!canTransition(order.status, status)) return res.status(400).json({ error: `${order.status} → ${status} 상태 변경은 허용되지 않습니다` });
  if (status === ORDER_STATUSES.DELIVERED && !order.paid_at) {
    return res.status(400).json({ error: '결제가 완료되지 않은 발주서는 납품완료로 변경할 수 없습니다' });
  }
  if (status === ORDER_STATUSES.CANCELED) {
    const blocked = cancelBlockReason(order);
    if (blocked) return res.status(400).json({ error: blocked });
  }

  const update = { status };
  if (status === ORDER_STATUSES.CONFIRMED) update.confirmed_at = new Date().toISOString();
  if (status === ORDER_STATUSES.SHIPPED) update.shipped_at = new Date().toISOString();
  if (status === ORDER_STATUSES.DELIVERED) update.delivered_at = new Date().toISOString();
  // 수정요청은 가맹점이 다시 손봐야 하는 상태라 들어와야만 알 수 있으면 발주가 그대로 묵혀짐 — 알림 플래그를 같이 세운다
  if (status === ORDER_STATUSES.REVISION_REQUESTED) {
    update.needs_attention = true;
    update.attention_note = reason ? `수정요청: ${reason}` : '수정요청';
  }

  await knex('purchase_orders').where({ id: order.id }).update(update);
  await logHistory(order.id, 'STATUS_CHANGE', { status: order.status }, { status }, reason, req.user.id);

  // 납품 완료 시 linked ingredient 재고 반영 (없으면 자동 생성)
  // stock_applied=false 조건의 원자적 업데이트로, 같은 발주서에 대해 중복 호출되거나 환불과 동시에 들어와도 재고가 두 번 반영되지 않도록 함
  if (status === ORDER_STATUSES.DELIVERED) {
    await knex.transaction(async (trx) => {
      const claimed = await trx('purchase_orders').where({ id: order.id, stock_applied: false }).update({ stock_applied: true });
      if (claimed) await applyDeliveryStock(order, 1, trx);
    });
  }

  res.json({ ok: true });
});

// ── 가맹점 수령확인(검수) ─────────────────────────────
// 본사가 "납품완료"로 바꿔도 실제로 가맹점이 받은 물량이 맞는지는 별개 — 가맹점이 직접 확인하고,
// 문제가 있으면(파손/누락 등) 전화 대신 시스템으로 신고할 수 있게 함
router.post('/:id/receipt-confirm', requireAuth, async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (!isStoreRole(req.user.role) || order.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '가맹점만 수령확인할 수 있습니다' });
  }
  if (order.status !== ORDER_STATUSES.DELIVERED) return res.status(400).json({ error: '납품완료 상태가 아닙니다' });
  if (order.receipt_confirmed_at || order.receipt_issue_note) {
    return res.status(400).json({ error: '이미 수령확인 또는 이상신고가 처리된 발주서입니다' });
  }

  const { ok, note } = req.body;
  if (ok) {
    // 수령확인까지 끝나면 더 손댈 일이 없는 완전 종료 상태(CLOSED)로 — "배송은 끝났지만 확인 대기 중"인
    // DELIVERED와 구분해서, 환불/품절처리 등 후속 액션이 필요한 발주서만 진짜로 남아있게 한다
    await knex('purchase_orders').where({ id: order.id }).update({ receipt_confirmed_at: new Date().toISOString(), status: ORDER_STATUSES.CLOSED });
    await logHistory(order.id, 'RECEIPT_CONFIRMED', { status: order.status }, { status: ORDER_STATUSES.CLOSED }, null, req.user.id);
  } else {
    if (!note || !note.trim()) return res.status(400).json({ error: '이상 신고 내용을 입력해주세요' });
    await knex('purchase_orders').where({ id: order.id }).update({ receipt_issue_note: note.trim() });
    await logHistory(order.id, 'RECEIPT_ISSUE', null, null, note.trim(), req.user.id);
  }
  res.json({ ok: true });
});

router.post('/:id/receipt-issue/resolve', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (order.status !== ORDER_STATUSES.DELIVERED && order.status !== ORDER_STATUSES.CLOSED) {
    return res.status(400).json({ error: '납품완료 이후 상태에서만 이상신고를 처리할 수 있습니다' });
  }
  if (!order.receipt_issue_note) return res.status(400).json({ error: '접수된 이상신고가 없습니다' });
  // 이미 CLOSED(수령확인 완료 등)인 발주서까지 여기서 다시 CLOSED로 덮어쓸 이유는 없으므로
  // 아직 DELIVERED인 경우에만 상태를 CLOSED로 바꾼다
  const update = { receipt_issue_resolved_at: new Date().toISOString() };
  if (order.status === ORDER_STATUSES.DELIVERED) update.status = ORDER_STATUSES.CLOSED;
  await knex('purchase_orders').where({ id: order.id }).update(update);
  await logHistory(order.id, 'RECEIPT_ISSUE_RESOLVED', { status: order.status }, { status: update.status || order.status }, null, req.user.id);
  res.json({ ok: true });
});

// 확정금액이 여러 라우트에서 제각각 계산되던 것을 여기 하나로 모은다. 예전엔 PUT items에서만
// 계산했고 그마저 status를 안 봐서 품절 처리한 상품이 결제 금액에 그대로 남아 있었다.
// 반환: 계산된 confirmed_amount(정수)
async function recalcOrderAmounts(trx, orderId) {
  const items = await trx('purchase_order_items').where({ order_id: orderId });
  let total = 0;
  for (const i of items) {
    const qty = i.status === PURCHASE_ORDER_ITEM_STATUSES.OUT_OF_STOCK ? 0 : (i.confirmed_quantity ?? i.quantity);
    const amount = Math.round((i.unit_price || 0) * qty);
    total += amount;
    // 금액이 실제로 달라질 때만 UPDATE — 거래명세서(OrderInvoice)의 행 금액과 합계가 어긋나지 않도록
    // amount는 항상 이 규칙으로만 채워진다.
    if (i.amount !== amount) await trx('purchase_order_items').where({ id: i.id }).update({ amount });
  }
  await trx('purchase_orders').where({ id: orderId }).update({ confirmed_amount: total });
  return total;
}

// sign: 1 = 납품 완료(입고), -1 = 환불로 인한 입고 취소. qty가 없으면 품목의 (확정수량 - 이미 환불된 수량)을 사용
// trx: 호출자가 트랜잭션 안에서 실행 중이면 그 트랜잭션을 그대로 사용 (납품확정/환불이 동시에 들어와도 재고가 중복·누락 반영되지 않도록)
async function applyDeliveryStock(order, sign, trx = knex) {
  const items = await trx('purchase_order_items').where({ order_id: order.id });
  for (const item of items) {
    const baseQty = item.confirmed_quantity ?? item.quantity;
    // sign>0(납품 반영)에서도 refunded_quantity를 빼야 한다 — "결제 후 품절 → 품목 환불 → 납품완료" 순서에서
    // 이미 환불한 수량까지 재고로 들어오는 문제가 있었다.
    const qty = baseQty - (item.refunded_quantity || 0);
    if (qty <= 0) continue;
    await applyItemStock(order, item, qty, sign, trx);
  }
}

// 품목 하나에 대해 재고를 가감 (전체 재고반영/전체환불/품목별 환불 모두 공용으로 사용)
async function applyItemStock(order, item, qty, sign, trx = knex) {
  if (!item.product_id) return;
  const product = await trx('products').where({ id: item.product_id }).first();
  if (!product) return;
  const delta = sign * qty * (product.unit_conversion || 1);

  // ingredient 연결 상품은 브랜드 공통 원본을 이름으로 매칭해서 가맹점별 ingredient를 찾고,
  // 미연결 상품은 상품명 그대로 가맹점 재료를 찾는다 — 둘 다 없으면(환불 외 신규) 새로 만든다
  let baseName, unit, threshold;
  if (product.ingredient_id) {
    const base = await trx('ingredients').where({ id: product.ingredient_id }).first();
    if (!base) return;
    baseName = base.name || product.name;
    unit = base.unit;
    threshold = base.threshold || 0;
  } else {
    baseName = item.product_name || product.name;
    unit = product.base_unit || product.unit || '개';
    threshold = 0;
  }
  if (!baseName) return; // 이름을 알 수 없으면 빈 이름 재료를 만들지 않고 건너뜀

  let ing = await trx('ingredients')
    .where({ brand_id: order.brand_id, store_id: order.store_id, name: baseName }).first();
  if (!ing) {
    if (sign < 0) return; // 환불 시 재료가 없으면 만들지 않음
    const [{ id: newId }] = await trx('ingredients').insert({
      brand_id: order.brand_id, store_id: order.store_id,
      name: baseName, unit, stock: 0, threshold,
    }).returning('id');
    ing = { id: newId, stock: 0 };
  }

  // sign<0(환불)일 때 stock을 읽어서 계산한 값으로 그대로 SET하면, 그 사이 다른 판매/입고 트랜잭션이
  // 같은 재료의 stock을 바꿔도 무시되고 덮어써지는 lost-update가 생길 수 있다 (특히 결제 직후
  // 토스 웹훅으로 들어오는 판매 차감과 본사 환불처리가 동시에 들어오는 경우 실제로 발생 가능).
  // 0 미만으로 못 내려가게 하는 CASE문을 포함해 단일 원자적 UPDATE로 처리해 이 문제를 없앤다.
  const beforeStock = ing.stock || 0;
  if (sign < 0) {
    await trx('ingredients').where({ id: ing.id }).update({
      stock: trx.raw('CASE WHEN stock + ? < 0 THEN 0 ELSE stock + ? END', [delta, delta]),
    });
  } else {
    await trx('ingredients').where({ id: ing.id }).increment('stock', delta);
  }
  const updatedIng = await trx('ingredients').where({ id: ing.id }).first();
  const afterStock = updatedIng.stock;

  await logStockMovement(trx, {
    brand_id: order.brand_id, store_id: order.store_id, ingredient_id: ing.id,
    type: sign > 0 ? STOCK_LEDGER_TYPES.DELIVERY : STOCK_LEDGER_TYPES.REFUND, delta,
    before_stock: beforeStock, after_stock: afterStock,
    ref_type: 'purchase_order', ref_id: order.id,
  });
}

// ── 본사 수량 수정 / 품절 / 대체상품 ─────────────────
// 결제 단계 이후(결제대기~완료/배송)에는 수량을 건드릴 수 없게 막는다 — 결제 금액·재고반영 기준이 confirmed_quantity라서
// 결제 후 수량이 바뀌면 결제승인 금액 검증이 깨지거나(이미 낸 돈과 불일치) 납품 시 재고가 실제와 다르게 반영됨
const ITEM_EDIT_LOCKED_STATUSES = [ORDER_STATUSES.PAYMENT_PENDING, ORDER_STATUSES.PAID, ORDER_STATUSES.PREPARING_SHIPMENT, ORDER_STATUSES.SHIPPED, ORDER_STATUSES.DELIVERED, ORDER_STATUSES.CLOSED, ORDER_STATUSES.CANCELED];

router.put('/:id/items/:itemId', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (ITEM_EDIT_LOCKED_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: '결제가 시작된 이후에는 품목 수량을 수정할 수 없습니다' });
  }
  const { confirmed_quantity, status, reason, substitute_note } = req.body;
  const item = await knex('purchase_order_items').where({ id: req.params.itemId, order_id: req.params.id }).first();
  if (!item) return res.status(404).json({ error: '없음' });

  const before = { quantity: item.confirmed_quantity ?? item.quantity, status: item.status };

  // "confirmed_quantity ?? item.quantity" 폴백이 문제였다 — 클라이언트가 대체메모만 보내면 그 폴백이
  // 이전에 10→5로 줄여둔 확정수량을 원래 발주량 10으로 되돌려, 가맹점이 조정 전 금액으로 결제하게 됐다.
  // 보낸 필드만 쓴다.
  const update = {};
  if (confirmed_quantity !== undefined) {
    // confirmed_quantity 검증: Number(null)===0이라 null이 "0으로 확정"으로 통과했고, 3.5 같은 소수도
    // 통과해 재고 반영/환불 수량 계산에 소수가 섞였다. 타입 자체를 먼저 거른다.
    if (confirmed_quantity === null || typeof confirmed_quantity === 'boolean') {
      return res.status(400).json({ error: `확정 수량은 0 이상 발주 수량(${item.quantity}) 이하의 정수여야 합니다` });
    }
    const q = Number(confirmed_quantity);
    if (!Number.isInteger(q) || q < 0 || q > item.quantity) {
      return res.status(400).json({ error: `확정 수량은 0 이상 발주 수량(${item.quantity}) 이하의 정수여야 합니다` });
    }
    update.confirmed_quantity = q;
  }
  if (status !== undefined) {
    if (!Object.values(PURCHASE_ORDER_ITEM_STATUSES).includes(status)) {
      return res.status(400).json({ error: '품목 상태 값이 올바르지 않습니다' });
    }
    update.status = status;
  }
  if (substitute_note !== undefined) update.substitute_note = substitute_note;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: '변경할 내용이 없습니다' });

  // HQOrders의 품절 토글은 {status:'OUT_OF_STOCK'}만 보낸다. confirmed_quantity를 안 건드리면
  // applyDeliveryStock의 (confirmed_quantity ?? quantity)가 품절 상품을 그대로 입고시키고,
  // 확정금액에도 그대로 남아 가맹점이 못 받은 물건 값을 결제한다.
  if (update.status === PURCHASE_ORDER_ITEM_STATUSES.OUT_OF_STOCK && update.confirmed_quantity === undefined) update.confirmed_quantity = 0;
  // 품절을 되돌릴 땐 원 발주수량으로 복원(null = "조정 없음")
  if (update.status && update.status !== PURCHASE_ORDER_ITEM_STATUSES.OUT_OF_STOCK
      && item.status === PURCHASE_ORDER_ITEM_STATUSES.OUT_OF_STOCK && update.confirmed_quantity === undefined) update.confirmed_quantity = null;

  await knex.transaction(async (trx) => {
    await trx('purchase_order_items').where({ id: item.id }).update(update);
    await recalcOrderAmounts(trx, req.params.id);
  });

  await logHistory(req.params.id, 'QUANTITY_CHANGE', before, { confirmed_quantity, status, substitute_note }, reason, req.user.id, item.id);

  // 수량이 줄거나 품절/대체 처리된 경우 가맹점이 모르고 지나치지 않도록 알림 플래그를 세운다
  const quantityReduced = confirmed_quantity !== undefined && Number(confirmed_quantity) < before.quantity;
  const markedOutOfStock = status === PURCHASE_ORDER_ITEM_STATUSES.OUT_OF_STOCK && before.status !== PURCHASE_ORDER_ITEM_STATUSES.OUT_OF_STOCK;
  if (quantityReduced || markedOutOfStock || substitute_note) {
    const label = markedOutOfStock ? '품절 처리' : quantityReduced ? '수량 조정' : '대체상품 안내';
    await flagNeedsAttention(req.params.id, `${item.product_name}: ${label}`);
  }

  res.json({ ok: true });
});

// ── 결제 준비 (대금 결제용 주문 코드 발급) ─────────────
router.post('/:id/payment/prepare', requireAuth, async (req, res) => {
  const order = await knex('purchase_orders as po')
    .join('stores as s', 'po.store_id', 's.id')
    .select('po.*', 's.name as store_name')
    .where('po.id', req.params.id)
    .where('po.brand_id', req.user.brand_id)
    .first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (['STORE_OWNER', 'STORE_STAFF'].includes(req.user.role) && order.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '권한 없음' });
  }
  if (![ORDER_STATUSES.CONFIRMED, ORDER_STATUSES.PAYMENT_PENDING].includes(order.status)) {
    return res.status(400).json({ error: '결제 가능 상태가 아닙니다' });
  }

  const amount = Math.round(order.confirmed_amount ?? order.total_amount);
  const orderCode = order.toss_order_code || `po-${order.id}-${crypto.randomBytes(6).toString('hex')}`;

  // updated_at을 명시적으로 갱신 — 결제대기 방치 감지(결제대기 후 N시간 경과)가 이 시각을 기준으로 계산되므로
  // status만 바꾸고 updated_at을 안 갱신하면 "방치 시간"이 실제보다 더 길게(주문 생성 시점부터) 잡힘
  await knex('purchase_orders').where({ id: order.id }).update({ toss_order_code: orderCode, status: ORDER_STATUSES.PAYMENT_PENDING, updated_at: new Date().toISOString() });
  await logHistory(order.id, 'STATUS_CHANGE', { status: order.status }, { status: ORDER_STATUSES.PAYMENT_PENDING }, '결제 시작', req.user.id);

  res.json({
    orderId: orderCode,
    amount,
    orderName: `발주서 #${order.id} (${order.store_name})`,
  });
});

// ── 결제 승인 (Toss 결제창에서 successUrl로 돌아온 뒤 호출) ─────────────
router.post('/:id/payment/confirm', requireAuth, async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (isStoreRole(req.user.role) && order.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '권한 없음' });
  }
  if (order.toss_order_code !== orderId) return res.status(400).json({ error: '주문 정보 불일치' });
  // 중복 클릭/재시도로 같은 결제승인이 두 번 들어와도 Toss에 다시 확인 요청을 보내지 않도록 가드
  if (order.status === ORDER_STATUSES.PAID) return res.status(400).json({ error: '이미 결제가 완료된 발주서입니다' });

  const expectedAmount = Math.round(order.confirmed_amount ?? order.total_amount);
  if (Math.round(amount) !== expectedAmount) return res.status(400).json({ error: '결제 금액 불일치' });
  if (!TOSS_SECRET_KEY) return res.status(500).json({ error: '결제 설정 오류 (TOSS_SECRET_KEY 미설정)' });

  const authHeader = 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  const tossRes = await fetch(`${TOSS_API_BASE}/confirm`, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const result = await tossRes.json();
  if (!tossRes.ok) {
    return res.status(tossRes.status).json({ error: result.message || '결제 승인 실패', code: result.code });
  }

  await knex('purchase_orders').where({ id: order.id }).update({
    status: ORDER_STATUSES.PAID, toss_payment_key: paymentKey, paid_at: new Date().toISOString(),
  });

  // payments 테이블에 결제 수단/원문을 남긴다 — purchase_orders에는 결제수단이 아예 저장되지 않아
  // 정산 시 무엇으로 결제됐는지 알 수 없었던 문제를 해결. 승인 재시도로 같은 paymentKey가 다시 들어와도
  // (payment_key unique) 500이 나지 않도록 onConflict merge로 멱등하게 처리한다.
  await knex('payments').insert({
    order_id: order.id,
    payment_key: paymentKey,
    status: PAYMENT_STATUSES.PAID,
    amount: result.totalAmount ?? amount,
    method: result.method || null,
    raw_response: JSON.stringify(result),
    paid_at: result.approvedAt ? new Date(result.approvedAt).toISOString() : new Date().toISOString(),
  }).onConflict('payment_key').merge();

  await logHistory(order.id, 'STATUS_CHANGE', { status: order.status }, { status: ORDER_STATUSES.PAID }, '결제 완료', req.user.id);
  await logAudit(req.user.brand_id, req.user.id, 'PAYMENT', order.id, ORDER_STATUSES.PAID, null, { amount, paymentKey });

  res.json({ ok: true, order: result });
});

// 예전엔 토스 취소를 먼저 부르고 DB는 refunded_amount = alreadyRefunded + refundAmount를 절대값으로
// SET했다. 동시 2건이면 둘 다 같은 alreadyRefunded를 읽어 토스 취소가 2회 나가고 장부는 1회분만
// 남으며 재고는 2회 원복됐다(5봉 환불 2건 동시 → 재고 10000→0 재현). refunded_amount 자체를 낙관적
// 버전으로 삼아 토스 호출 전에 선점한다.
// 토스 취소 API를 부르기 전에 refunded_amount를 기대값 조건으로 미리 올려 선점한다.
// 반환 true면 이 요청이 이번 환불의 소유자다. false면 그 사이 다른 요청이 먼저 환불했다는 뜻.
async function claimRefundAmount(orderId, expectedRefunded, nextRefunded) {
  // NULL 정규화 — refunded_amount가 아직 한 번도 세팅된 적 없는 주문은 NULL이라 숫자 비교(expectedRefunded=0)가
  // 안 맞아 선점에 항상 실패하므로, 먼저 0으로 채워둔다.
  await knex('purchase_orders').where({ id: orderId }).whereNull('refunded_amount').update({ refunded_amount: 0 });
  const n = await knex('purchase_orders').where({ id: orderId, refunded_amount: expectedRefunded }).update({ refunded_amount: nextRefunded });
  return n === 1;
}

// 토스 호출이 실패했을 때 선점을 되돌린다(내가 쓴 값일 때만 — 그 사이 다른 요청이 또 선점했다면 건드리지 않는다).
async function releaseRefundClaim(orderId, claimedAmount, revertTo) {
  await knex('purchase_orders').where({ id: orderId, refunded_amount: claimedAmount }).update({ refunded_amount: revertTo });
}

// ── 결제 취소 (환불, 전액/부분) — 결제 완료된 발주서를 본사가 환불 처리 ─
router.post('/:id/refund', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  // CLOSED(수령확인/이상신고 처리까지 끝난 상태)도 결제 완료 이후 상태이므로 환불은 계속 가능해야 함
  if (![ORDER_STATUSES.PAID, ORDER_STATUSES.PREPARING_SHIPMENT, ORDER_STATUSES.SHIPPED, ORDER_STATUSES.DELIVERED, ORDER_STATUSES.CLOSED].includes(order.status)) {
    return res.status(400).json({ error: '결제 완료 이후 상태에서만 환불할 수 있습니다' });
  }
  if (!order.toss_payment_key) return res.status(400).json({ error: '결제 정보가 없습니다' });
  if (!TOSS_SECRET_KEY) return res.status(500).json({ error: '결제 설정 오류 (TOSS_SECRET_KEY 미설정)' });

  const { reason, amount, reason_code } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: '환불 사유를 입력해주세요' });

  const totalAmount = Math.round(order.confirmed_amount ?? order.total_amount);
  const alreadyRefunded = Math.round(order.refunded_amount || 0);
  const remaining = totalAmount - alreadyRefunded;
  if (remaining <= 0) return res.status(400).json({ error: '이미 전액 환불되었습니다' });

  const refundAmount = amount !== undefined ? Math.round(amount) : remaining;
  if (!refundAmount || refundAmount <= 0 || refundAmount > remaining) {
    return res.status(400).json({ error: `환불 금액이 올바르지 않습니다 (남은 환불 가능 금액: ${remaining.toLocaleString()}원)` });
  }

  const newRefunded = alreadyRefunded + refundAmount;
  const isFull = newRefunded >= totalAmount;

  if (!await claimRefundAmount(order.id, alreadyRefunded, newRefunded)) {
    return res.status(409).json({ error: '다른 환불 요청이 먼저 처리되었습니다. 새로고침 후 다시 확인해주세요' });
  }

  const authHeader = 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  // 선점(claimRefundAmount) 이후 네트워크 단절/타임아웃/토스가 HTML 에러 페이지를 돌려줘 json()이 throw하는
  // 경우를 못 잡으면 asyncRouter가 500을 내고 refunded_amount만 올라간 채 영구히 남는다 — 재시도해도
  // '이미 전액 환불' 400만 반복되어 복구 불가. 반드시 선점을 되돌리고 재시도 가능한 상태로 되돌려야 한다.
  let tossRes, result;
  try {
    tossRes = await fetch(`${TOSS_API_BASE}/${order.toss_payment_key}/cancel`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelReason: reason, cancelAmount: refundAmount }),
    });
    result = await tossRes.json();
  } catch (err) {
    await releaseRefundClaim(order.id, newRefunded, alreadyRefunded);
    return res.status(502).json({ error: '토스 환불 요청에 실패했습니다. 잠시 후 다시 시도해주세요' });
  }
  if (!tossRes.ok) {
    await releaseRefundClaim(order.id, newRefunded, alreadyRefunded);
    return res.status(tossRes.status).json({ error: result.message || '환불 처리 실패', code: result.code });
  }

  // stock_reversed=false 조건이 달린 조건부 업데이트로 재고 차감 권한을 원자적으로 선점
  // (환불 버튼과 웹훅 동기화가 동시에 들어와도 재고가 두 번 깎이지 않도록). 선점과 재고반영을 한 트랜잭션으로 묶어
  // 재고반영 중 오류가 나도 선점 플래그만 남고 재고는 그대로인 불일치 상태가 생기지 않게 함.
  // refunded_amount는 위 claimRefundAmount에서 이미 반영했으므로 여기서는 다시 넣지 않는다.
  const next = {};
  if (isFull) next.status = ORDER_STATUSES.CANCELED;

  try {
    await knex.transaction(async (trx) => {
      // status==='DELIVERED' 문자열로 체크하면 CLOSED로 종료된 주문은 재고 반영분이 있어도 안 걸려서
      // 전액환불 시 재고가 안 빠지는 누락이 생긴다 — 실제로 재고가 반영됐는지를 뜻하는 stock_applied로 판단
      if (isFull && order.stock_applied && !order.stock_reversed) {
        const claimed = await trx('purchase_orders').where({ id: order.id, stock_reversed: false }).update({ stock_reversed: true });
        if (claimed) {
          await applyDeliveryStock(order, -1, trx);
          // applyDeliveryStock은 남은 물량을 정확히 되돌리지만 refunded_quantity를 갱신하지 않아,
          // 이후 /refund-items가 "아직 환불 안 된 물량이 남아있다"고 오판할 수 있었다.
          const orderItems = await trx('purchase_order_items').where({ order_id: order.id });
          for (const item of orderItems) {
            await trx('purchase_order_items').where({ id: item.id }).update({ refunded_quantity: item.confirmed_quantity ?? item.quantity });
          }
        }
      }
      if (Object.keys(next).length > 0) await trx('purchase_orders').where({ id: order.id }).update(next);
      // 재고반영과 같은 트랜잭션으로 묶어, payments 상태 갱신 중 오류가 나도 purchase_orders만 환불된 것으로
      // 바뀌고 payments는 그대로인 불일치가 생기지 않게 함. SQLite는 커넥션이 1개라 trx 안에서는 반드시 trx(...)를 써야 함
      const n = await trx('payments').where({ payment_key: order.toss_payment_key }).update({
        status: isFull ? PAYMENT_STATUSES.REFUNDED : PAYMENT_STATUSES.PARTIALLY_REFUNDED,
        raw_response: JSON.stringify(result),
      });
      // 환불 자체는 이미 토스에서 성공했으므로 여기서 예외를 던져 롤백하면 더 나쁘다 — 경고만 남긴다
      if (n === 0) console.warn('[환불] payments 행을 찾지 못해 결제 상태가 갱신되지 않았습니다:', order.toss_payment_key);
    });
  } catch (err) {
    // 선점 → 토스 취소 성공 → 여기서 실패. refunded_amount만 오른 채 status/재고/payments가 안 바뀌고,
    // 재시도하면 '이미 전액 환불되었습니다' 400만 반복되어 사람이 개입하기 전엔 복구가 불가능하다.
    // 선점을 되돌리면(토스에는 이미 취소가 나갔으므로) 이중 환불 위험이 생기므로 되돌리지 않고,
    // 대신 반드시 눈에 띄게 알린다. createRisk는 트랜잭션 밖에서만 호출한다(CLAUDE.md 4절).
    console.error('[환불] 토스 취소 성공 후 DB 반영 실패:', order.id, err);
    try {
      await createRisk(order.brand_id, order.store_id, RISK_TYPES.REFUND_INCONSISTENT, RISK_SEVERITIES.HIGH,
        `환불 반영 불일치: 발주 #${order.id} — 토스 취소 ${refundAmount.toLocaleString()}원은 완료됐으나 DB 반영이 실패했습니다. 재고/결제상태 수동 확인 필요 (${err.message})`,
        { order_id: order.id, refund_amount: refundAmount, refunded_amount: newRefunded, is_full: isFull, error: err.message, at: new Date().toISOString() });
    } catch (riskErr) { console.error('[환불] REFUND_INCONSISTENT 리스크 생성 실패:', riskErr.message); }
    return res.status(500).json({
      error: `토스 환불은 완료되었으나 시스템 반영 중 오류가 발생했습니다. 관리자에게 문의해주세요 (발주 #${order.id}, 환불 ${refundAmount.toLocaleString()}원)`,
      inconsistent: true, refunded_amount: newRefunded,
    });
  }

  const label = isFull ? '전액 환불' : `부분 환불 (${refundAmount.toLocaleString()}원)`;
  await logHistory(order.id, 'STATUS_CHANGE', { status: order.status }, { status: next.status || order.status }, `${label}: ${reason}`, req.user.id, null, reason_code);
  await logAudit(req.user.brand_id, req.user.id, 'PAYMENT', order.id, isFull ? 'REFUND_FULL' : 'REFUND_PARTIAL',
    { refunded_amount: alreadyRefunded }, { refunded_amount: newRefunded, reason });

  res.json({ ok: true, order: result, refunded_amount: newRefunded, status: next.status || order.status });
});

// ── 결제 취소 (환불, 품목 단위) — 반품된 품목만큼만 금액/재고를 환불 ─
router.post('/:id/refund-items', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (![ORDER_STATUSES.PAID, ORDER_STATUSES.PREPARING_SHIPMENT, ORDER_STATUSES.SHIPPED, ORDER_STATUSES.DELIVERED, ORDER_STATUSES.CLOSED].includes(order.status)) {
    return res.status(400).json({ error: '결제 완료 이후 상태에서만 환불할 수 있습니다' });
  }
  if (!order.toss_payment_key) return res.status(400).json({ error: '결제 정보가 없습니다' });
  if (!TOSS_SECRET_KEY) return res.status(500).json({ error: '결제 설정 오류 (TOSS_SECRET_KEY 미설정)' });

  const { reason, items: requestedItems, reason_code } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: '환불 사유를 입력해주세요' });
  if (!Array.isArray(requestedItems) || requestedItems.length === 0) {
    return res.status(400).json({ error: '환불할 품목을 선택해주세요' });
  }

  const orderItems = await knex('purchase_order_items').where({ order_id: order.id });
  const itemsById = new Map(orderItems.map(i => [i.id, i]));

  // 같은 item_id를 두 번 넣으면 각각 독립적으로 maxQty 검증을 통과해 refunded_quantity가 발주량을
  // 초과했고(A 10개 발주에 [{A,10},{A,10}] → refunded 20), 그 결과 isFull이 되어 다른 품목은
  // 환불 한 푼 없이 전액환불 처리됐다. 검증 전에 item_id 기준으로 먼저 합친다.
  const mergedQty = new Map(); // item_id(Number) -> qty 합
  for (const r of requestedItems) {
    const id = Number(r?.item_id);
    const q = Number(r?.quantity);
    if (!Number.isFinite(id) || !itemsById.has(id)) return res.status(400).json({ error: '품목 정보가 올바르지 않습니다' });
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: '환불 수량이 올바르지 않습니다' });
    mergedQty.set(id, (mergedQty.get(id) || 0) + q);
  }

  let refundAmount = 0;
  const toApply = [];
  for (const [id, qty] of mergedQty) {
    const item = itemsById.get(id);
    const maxQty = (item.confirmed_quantity ?? item.quantity) - (item.refunded_quantity || 0);
    if (qty > maxQty + 1e-6) {
      return res.status(400).json({ error: `${item.product_name}의 환불 수량이 올바르지 않습니다 (환불 가능: ${maxQty})` });
    }
    refundAmount += item.unit_price * qty;
    toApply.push({ item, qty });
  }
  refundAmount = Math.round(refundAmount);

  const totalAmount = Math.round(order.confirmed_amount ?? order.total_amount);
  const alreadyRefunded = Math.round(order.refunded_amount || 0);
  const remaining = totalAmount - alreadyRefunded;
  if (refundAmount <= 0 || refundAmount > remaining) {
    return res.status(400).json({ error: `환불 금액이 올바르지 않습니다 (남은 환불 가능 금액: ${remaining.toLocaleString()}원)` });
  }

  const newRefunded = alreadyRefunded + refundAmount;
  const isFull = newRefunded >= totalAmount;

  if (!await claimRefundAmount(order.id, alreadyRefunded, newRefunded)) {
    return res.status(409).json({ error: '다른 환불 요청이 먼저 처리되었습니다. 새로고침 후 다시 확인해주세요' });
  }

  const authHeader = 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  // 선점(claimRefundAmount) 이후 네트워크 단절/타임아웃/토스가 HTML 에러 페이지를 돌려줘 json()이 throw하는
  // 경우를 못 잡으면 asyncRouter가 500을 내고 refunded_amount만 올라간 채 영구히 남는다 — 재시도해도
  // '이미 전액 환불' 400만 반복되어 복구 불가. 반드시 선점을 되돌리고 재시도 가능한 상태로 되돌려야 한다.
  let tossRes, result;
  try {
    tossRes = await fetch(`${TOSS_API_BASE}/${order.toss_payment_key}/cancel`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelReason: reason, cancelAmount: refundAmount }),
    });
    result = await tossRes.json();
  } catch (err) {
    await releaseRefundClaim(order.id, newRefunded, alreadyRefunded);
    return res.status(502).json({ error: '토스 환불 요청에 실패했습니다. 잠시 후 다시 시도해주세요' });
  }
  if (!tossRes.ok) {
    await releaseRefundClaim(order.id, newRefunded, alreadyRefunded);
    return res.status(tossRes.status).json({ error: result.message || '환불 처리 실패', code: result.code });
  }

  // refunded_amount는 위 claimRefundAmount에서 이미 반영했으므로 여기서는 다시 넣지 않는다.
  const next = {};
  const requestedById = new Map(toApply.map(({ item, qty }) => [item.id, qty]));

  // 재고 반영 + 환불수량 누적 + 주문 갱신을 한 트랜잭션으로 묶어 중간에 실패해도 일부만 반영되는 불일치를 막음
  try {
    await knex.transaction(async (trx) => {
      // 실제로 재고가 반영된 발주서(stock_applied)만 되돌릴 게 있음 — CLOSED로 종료된 주문도 포함되도록
      // status==='DELIVERED' 대신 stock_applied로 판단
      if (order.stock_applied) {
        for (const { item, qty } of toApply) await applyItemStock(order, item, qty, -1, trx);
      }
      for (const { item, qty } of toApply) {
        await trx('purchase_order_items').where({ id: item.id }).increment('refunded_quantity', qty);
      }
      if (isFull) {
        // /refund(금액)로 일부를 먼저 환불한 뒤 /refund-items로 나머지를 채워 isFull이 되면, 예전 코드는
        // stock_reversed=true만 세우고 요청에 없던 품목의 납품 재고는 영영 원복하지 않았다(C만 환불했는데
        // D 재고 10 잔존, stock_reversed=1). 전액 환불이 성립하는 순간 남은 물량도 전부 되돌린다.
        const claimed = await trx('purchase_orders').where({ id: order.id, stock_reversed: false }).update({ stock_reversed: true });
        if (claimed) {
          for (const item of orderItems) {
            const already = (item.refunded_quantity || 0) + (requestedById.get(item.id) || 0);
            const leftover = (item.confirmed_quantity ?? item.quantity) - already;
            if (leftover <= 1e-6) continue;
            if (order.stock_applied) await applyItemStock(order, item, leftover, -1, trx);
            await trx('purchase_order_items').where({ id: item.id }).increment('refunded_quantity', leftover);
          }
        }
        next.status = ORDER_STATUSES.CANCELED; // next.stock_reversed = true 는 위 조건부 UPDATE로 대체 — 삭제
      }
      if (Object.keys(next).length > 0) await trx('purchase_orders').where({ id: order.id }).update(next);
      // 위 재고/수량 갱신과 한 트랜잭션으로 묶어 payments 상태만 반영이 안 되는 불일치를 막는다.
      // SQLite는 커넥션이 1개라 trx 안에서는 반드시 trx(...)를 써야 함(knex(...) 호출 시 교착)
      const n = await trx('payments').where({ payment_key: order.toss_payment_key }).update({
        status: isFull ? PAYMENT_STATUSES.REFUNDED : PAYMENT_STATUSES.PARTIALLY_REFUNDED,
        raw_response: JSON.stringify(result),
      });
      // 환불 자체는 이미 토스에서 성공했으므로 여기서 예외를 던져 롤백하면 더 나쁘다 — 경고만 남긴다
      if (n === 0) console.warn('[환불] payments 행을 찾지 못해 결제 상태가 갱신되지 않았습니다:', order.toss_payment_key);
    });
  } catch (err) {
    // 선점 → 토스 취소 성공 → 여기서 실패. refunded_amount만 오른 채 status/재고/payments가 안 바뀌고,
    // 재시도하면 '이미 전액 환불되었습니다' 400만 반복되어 사람이 개입하기 전엔 복구가 불가능하다.
    // 선점을 되돌리면(토스에는 이미 취소가 나갔으므로) 이중 환불 위험이 생기므로 되돌리지 않고,
    // 대신 반드시 눈에 띄게 알린다. createRisk는 트랜잭션 밖에서만 호출한다(CLAUDE.md 4절).
    console.error('[환불] 토스 취소 성공 후 DB 반영 실패:', order.id, err);
    try {
      await createRisk(order.brand_id, order.store_id, RISK_TYPES.REFUND_INCONSISTENT, RISK_SEVERITIES.HIGH,
        `환불 반영 불일치: 발주 #${order.id} — 토스 취소 ${refundAmount.toLocaleString()}원은 완료됐으나 DB 반영이 실패했습니다. 재고/결제상태 수동 확인 필요 (${err.message})`,
        { order_id: order.id, refund_amount: refundAmount, refunded_amount: newRefunded, is_full: isFull, error: err.message, at: new Date().toISOString() });
    } catch (riskErr) { console.error('[환불] REFUND_INCONSISTENT 리스크 생성 실패:', riskErr.message); }
    return res.status(500).json({
      error: `토스 환불은 완료되었으나 시스템 반영 중 오류가 발생했습니다. 관리자에게 문의해주세요 (발주 #${order.id}, 환불 ${refundAmount.toLocaleString()}원)`,
      inconsistent: true, refunded_amount: newRefunded,
    });
  }

  const itemSummary = toApply.map(({ item, qty }) => `${item.product_name} x${qty}`).join(', ');
  const label = isFull ? '전액 환불(품목단위)' : `부분 환불(품목단위, ${refundAmount.toLocaleString()}원)`;
  await logHistory(order.id, 'STATUS_CHANGE', { status: order.status }, { status: next.status || order.status },
    `${label}: ${itemSummary} — ${reason}`, req.user.id, null, reason_code);
  await logAudit(req.user.brand_id, req.user.id, 'PAYMENT', order.id, isFull ? 'REFUND_FULL' : 'REFUND_PARTIAL',
    { refunded_amount: alreadyRefunded }, { refunded_amount: newRefunded, items: itemSummary, reason });

  res.json({ ok: true, order: result, refunded_amount: newRefunded, status: next.status || order.status });
});

// ── 발주서 취소 ───────────────────────────────────────
// HQ_ACCOUNTING(회계)은 조회 전용인데 역할 검사가 없어 발주 취소가 가능했다. 가맹점 역할은 자기 매장
// 발주를 직접 취소해야 하므로(StoreOrder의 '발주 취소' 버튼) 함께 허용한다 — 매장 소유 검사는 아래
// isStoreRole 분기가 이미 한다.
router.delete('/:id', requireAuth, requireRole(...LOGISTICS_ROLES, ...STORE_ROLES), async (req, res) => {
  const order = await knex('purchase_orders').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!order) return res.status(404).json({ error: '없음' });
  if (isStoreRole(req.user.role) && order.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '권한 없음' });
  }
  const blocked = cancelBlockReason(order);
  if (blocked) return res.status(400).json({ error: blocked });
  await knex('purchase_orders').where({ id: order.id }).update({ status: ORDER_STATUSES.CANCELED });
  await logHistory(order.id, 'STATUS_CHANGE', { status: order.status }, { status: ORDER_STATUSES.CANCELED }, '취소', req.user.id);
  res.json({ ok: true });
});

// ── 토스페이먼츠 결제 상태 변경 웹훅 ───────────────────
// 토스 개발자센터에서 직접 취소하는 등, 우리 사이트를 거치지 않은 결제 변경 사항도 동기화한다.
// 웹훅 payload는 신뢰하지 않고 paymentKey로 토스 서버에 직접 조회해 받은 값만 반영한다.
router.post('/toss-webhook', async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);

    // 토스페이먼츠 웹훅은 서명 헤더를 보내지 않으므로 별도 서명 검증은 하지 않는다.
    // 대신 payload는 신뢰하지 않고, paymentKey로 토스 서버에 직접 재조회해 받은 값만 반영한다.
    const payload = JSON.parse(rawBody);
    const paymentKey = payload?.data?.paymentKey || payload?.paymentKey;
    console.log('[토스 웹훅] 수신:', payload?.eventType, paymentKey);
    if (!paymentKey || !TOSS_SECRET_KEY) { console.log('[토스 웹훅] paymentKey 또는 TOSS_SECRET_KEY 없음'); return res.sendStatus(200); }

    const order = await knex('purchase_orders').where({ toss_payment_key: paymentKey }).first();
    if (!order) { console.log('[토스 웹훅] 일치하는 주문 없음:', paymentKey); return res.sendStatus(200); }

    const authHeader = 'Basic ' + Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
    const tossRes = await fetch(`${TOSS_API_BASE}/${paymentKey}`, { headers: { Authorization: authHeader } });
    if (!tossRes.ok) { console.log('[토스 웹훅] 토스 재조회 실패:', tossRes.status, await tossRes.text()); return res.sendStatus(200); }
    const payment = await tossRes.json();
    console.log('[토스 웹훅] 토스 재조회 결과:', payment.status, payment.totalAmount, payment.balanceAmount);

    const refundedAmount = Math.round((payment.totalAmount || 0) - (payment.balanceAmount ?? payment.totalAmount));
    if (refundedAmount === Math.round(order.refunded_amount || 0)) { console.log('[토스 웹훅] 변경 없음, order_id:', order.id); return res.sendStatus(200); }

    const isFull = (payment.balanceAmount ?? 0) <= 0 || payment.status === PAYMENT_STATUSES.CANCELED;
    console.log('[토스 웹훅] 동기화 진행: order_id', order.id, 'refundedAmount', refundedAmount, 'isFull', isFull);

    const next = { refunded_amount: refundedAmount };
    if (isFull) next.status = ORDER_STATUSES.CANCELED;
    await knex.transaction(async (trx) => {
      if (isFull && order.stock_applied && !order.stock_reversed) {
        const claimed = await trx('purchase_orders').where({ id: order.id, stock_reversed: false }).update({ stock_reversed: true });
        if (claimed) await applyDeliveryStock(order, -1, trx);
      }
      await trx('purchase_orders').where({ id: order.id }).update(next);
      // 토스 대시보드에서 직접 취소된 건도 payments에 반영해야 정산 화면에서 상태가 어긋나지 않는다.
      // 같은 트랜잭션 안이므로 반드시 trx(...) 사용 (knex(...)는 SQLite 단일 커넥션에서 교착)
      const n = await trx('payments').where({ payment_key: paymentKey }).update({
        status: isFull ? PAYMENT_STATUSES.REFUNDED : PAYMENT_STATUSES.PARTIALLY_REFUNDED,
        raw_response: JSON.stringify(payment),
      });
      // 환불 자체는 이미 토스에서 성공했으므로 여기서 예외를 던져 롤백하면 더 나쁘다 — 경고만 남긴다
      if (n === 0) console.warn('[환불] payments 행을 찾지 못해 결제 상태가 갱신되지 않았습니다:', paymentKey);
    });
    await logHistory(order.id, 'STATUS_CHANGE', { status: order.status }, { status: next.status || order.status },
      '토스 대시보드에서 직접 취소 (웹훅 동기화)', null);
    await logAudit(order.brand_id, null, 'PAYMENT', order.id, 'REFUND_SYNC',
      { refunded_amount: order.refunded_amount || 0 }, { refunded_amount: refundedAmount });
    console.log('[토스 웹훅] 동기화 완료: order_id', order.id);

    res.sendStatus(200);
  } catch (err) {
    console.error('[토스 웹훅] 처리 오류:', err.message);
    res.sendStatus(200); // 토스 쪽 재시도 폭주 방지
  }
});

module.exports = router;
