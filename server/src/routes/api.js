const createAsyncRouter = require('../middleware/asyncRouter');
const router = createAsyncRouter();
const { knex, isProduction } = require('../db/schema');
const { requireAuth, requireRole, HQ_ROLES, LOGISTICS_ROLES, ADMIN_ROLES, STORE_ROLES } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { getOrderNode } = require('../orderFinance');
const { ORDER_STATUSES, RISK_TYPES, RISK_SEVERITIES, RISK_STATUSES, STOCK_LEDGER_TYPES, PURCHASE_RATIOS } = require('../constants');
const { syncStoreIntegrations } = require('../dbHelpers');
const { encryptCredential, decryptCredential } = require('../crypto');
const { logStockMovement } = require('../stockLedger');
const { toDbTime, dbTimeAgo, dbStartOfKstToday, kstDayRange } = require('../dbTime');
const { acquireStoreSyncLock, releaseStoreSyncLock } = require('../syncLock');
// "메뉴 하나가 재료를 얼마나 먹는지" 계산은 이 파일에서 직접 하지 않는다 — 웹훅의 재고 차감
// (routes/webhook.js)과 같은 로직을 써야 표준메뉴 연결/세트 계산이 사입 감시(getIngredientComparison)
// 에서도 똑같이 반영된다(menuResolver.js 상단 주석 참고).
const { resolveConsumption, resolveConsumptionBulk } = require('../menuResolver');

// sales_items 판매 건(메뉴명/toss_menu_id 기준)을 menus 행에 연결한다. webhook.js의 adjustStock과
// 같은 우선순위(ID 우선, 이름은 가맹점이 POS에서 바꿀 수 있어 폴백)를 따른다 — 여기서 매칭 규칙이
// 어긋나면, 이름을 바꿔 파는 메뉴가 재고 차감(웹훅)에서는 잡히는데 사입 계산에서는 매칭 실패로
// 계산되는 어긋남이 생겨 그 자체가 새 회피 경로가 된다.
function buildMenuIndex(menus) {
  const byTossId = new Map();
  const byName = new Map();
  for (const m of menus) {
    if (m.toss_menu_id && !byTossId.has(m.toss_menu_id)) byTossId.set(m.toss_menu_id, m);
    if (!byName.has(m.name)) byName.set(m.name, m);
  }
  return { byTossId, byName };
}
function matchMenu(index, tossMenuId, menuName) {
  let menu = null;
  if (tossMenuId) menu = index.byTossId.get(tossMenuId) || null;
  if (!menu && menuName) menu = index.byName.get(menuName) || null;
  return menu;
}

// 예전엔 new Date('아무거나').toISOString()이 RangeError를 던져 잘못된 쿼리스트링 하나로 500이 났다
// (/analytics, /settlement, /store-rankings, /purchase-anomalies, /channel-breakdown 전부).
function parseDateParam(value, fallback) {
  const d = (value === undefined || value === null || value === '')
    ? (fallback instanceof Date ? fallback : new Date(fallback))
    : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const DATE_PARAM_ERROR = '조회 기간(from/to) 형식이 올바르지 않습니다';

// ─── 브랜드 ───────────────────────────────────────────
router.get('/brands', requireAuth, async (req, res) => {
  if (req.user.role !== 'SUPER_ADMIN') return res.json([await knex('brands').where({ id: req.user.brand_id }).first()]);
  res.json(await knex('brands').orderBy('created_at'));
});

router.post('/brands', requireAuth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { name, code } = req.body;
  const [{ id }] = await knex('brands').insert({ name, code }).returning('id');
  res.json({ id });
});

// ─── 가맹점 ───────────────────────────────────────────
router.get('/stores', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const stores = await knex('stores as st')
    .leftJoin('users as u', 'st.assigned_user_id', 'u.id')
    .select('st.*', 'u.name as assigned_user_name')
    .where('st.brand_id', req.user.brand_id).orderBy('st.created_at');
  // 인증정보 평문은 SUPER_ADMIN/HQ_ADMIN에게만 노출, 나머지는 설정 여부만 전달
  const canSeeSecrets = ['SUPER_ADMIN', 'HQ_ADMIN'].includes(req.user.role);
  res.json(stores.map(s => {
    if (canSeeSecrets) {
      // DB 컬럼 값은 암호화되어 있을 수 있다(CREDENTIALS_KEY 설정 이후). 여기서 복호화하지 않고
      // 암호문을 그대로 응답에 담으면, 관리 화면(client/src/pages/Stores.jsx의 StoreModal)이 이
      // 값을 입력창에 그대로 채워넣고 사용자가 다른 필드만 고쳐 저장할 때 "암호문을 새 평문인 줄
      // 알고 다시 암호화"해버려 이중 암호화로 원래 시크릿을 영구히 잃는 사고가 난다(웹훅 서명 검증이
      // 조용히 깨짐). "SUPER_ADMIN/HQ_ADMIN에게는 평문 노출"이라는 원래 의도를 지키기 위해서도
      // 복호화해서 돌려준다.
      return {
        ...s,
        webhook_secret: decryptCredential(s.webhook_secret),
        toss_client_secret: decryptCredential(s.toss_client_secret),
      };
    }
    const { webhook_secret, toss_client_secret, ...rest } = s;
    return { ...rest, webhook_secret_set: !!webhook_secret, toss_client_secret_set: !!toss_client_secret };
  }));
});

// 가맹점 계정이 본인 매장의 발주 마감시간/납품요일 등을 확인할 수 있게 함 — /stores 전체 목록은
// HQ 전용이라 가맹점 로그인 화면(발주하기 등)에서 자기 매장 정보를 조회할 길이 없었음
router.get('/stores/me', requireAuth, async (req, res) => {
  if (!['STORE_OWNER', 'STORE_STAFF'].includes(req.user.role) || !req.user.store_id) {
    return res.status(403).json({ error: '가맹점 계정만 조회할 수 있습니다' });
  }
  const store = await knex('stores')
    .where({ id: req.user.store_id, brand_id: req.user.brand_id })
    .select('id', 'name', 'order_deadline', 'delivery_days')
    .first();
  res.json(store || null);
});

async function validAssignedUser(brand_id, assigned_user_id) {
  if (!assigned_user_id) return true;
  const user = await knex('users').where({ id: assigned_user_id, brand_id }).whereIn('role', HQ_ROLES).first();
  return !!user;
}

router.post('/stores', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const { name, webhook_secret, toss_store_id, order_deadline, delivery_days, business_number, owner_name, phone, open_date, franchise_type, is_open, address, assigned_user_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '가맹점명을 입력해주세요' });
  if (!(await validAssignedUser(req.user.brand_id, assigned_user_id))) return res.status(400).json({ error: '담당자를 찾을 수 없습니다' });
  const [{ id }] = await knex('stores').insert({
    brand_id: req.user.brand_id, name,
    webhook_secret: encryptCredential(webhook_secret || ''), toss_store_id: toss_store_id || '',
    order_deadline: order_deadline || null, delivery_days: delivery_days || null,
    business_number: business_number || null, owner_name: owner_name || null,
    phone: phone || null, open_date: open_date || null,
    franchise_type: franchise_type || null, is_open: is_open ?? true,
    address: address || null, assigned_user_id: assigned_user_id || null,
  }).returning('id');
  try {
    await syncStoreIntegrations(knex, id);
  } catch (error) {
    console.error('[store_integrations] 가맹점 생성 이중 기록 실패:', error.message);
  }
  res.json({ id });
});

router.put('/stores/:id', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const existing = await knex('stores').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  const { name, webhook_secret, toss_store_id, order_deadline, delivery_days, toss_client_id, toss_client_secret, business_number, owner_name, phone, open_date, franchise_type, is_open, address, assigned_user_id } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: '가맹점명을 입력해주세요' });
  if (assigned_user_id !== undefined && !(await validAssignedUser(req.user.brand_id, assigned_user_id))) {
    return res.status(400).json({ error: '담당자를 찾을 수 없습니다' });
  }
  // webhook_secret/toss_client_secret은 요청에 새 값이 왔을 때만 암호화해서 덮어쓴다. 기존 값을
  // 그대로 유지하는 경우(?? 폴백) DB에 있는 값을 다시 암호화하면 안 된다 — 이미 암호화됐다면
  // 이중 암호화로 원래 시크릿을 잃고, 평문이라면(키를 아직 안 넣은 상태에서 만들어진 행) 여기서
  // 굳이 새로 암호화할 이유가 없다(마이그레이션이 일괄 처리할 몫).
  const next = {
    name: name ?? existing.name,
    webhook_secret: webhook_secret != null ? encryptCredential(webhook_secret) : existing.webhook_secret,
    toss_store_id: toss_store_id ?? existing.toss_store_id,
    order_deadline: order_deadline ?? existing.order_deadline,
    delivery_days: delivery_days ?? existing.delivery_days,
    toss_client_id: toss_client_id ?? existing.toss_client_id,
    toss_client_secret: toss_client_secret != null ? encryptCredential(toss_client_secret) : existing.toss_client_secret,
    business_number: business_number ?? existing.business_number,
    owner_name: owner_name ?? existing.owner_name,
    phone: phone ?? existing.phone,
    open_date: open_date ?? existing.open_date,
    franchise_type: franchise_type ?? existing.franchise_type,
    is_open: is_open !== undefined ? is_open : existing.is_open,
    address: address ?? existing.address,
    assigned_user_id: assigned_user_id !== undefined ? (assigned_user_id || null) : existing.assigned_user_id,
  };
  await knex('stores').where({ id: req.params.id, brand_id: req.user.brand_id }).update(next);
  try {
    await syncStoreIntegrations(knex, existing.id);
  } catch (error) {
    console.error('[store_integrations] 가맹점 수정 이중 기록 실패:', error.message);
  }
  await logAudit(req.user.brand_id, req.user.id, 'STORE', existing.id, 'UPDATE',
    { name: existing.name, is_open: existing.is_open, business_number: existing.business_number },
    { name: next.name, is_open: next.is_open, business_number: next.business_number });
  res.json({ ok: true });
});

router.delete('/stores/:id', requireAuth, requireRole(...ADMIN_ROLES), async (req, res) => {
  const existing = await knex('stores').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '가맹점을 찾을 수 없습니다' });
  // 발주·매출·사용자 3종만 봐서, 재료와 실사만 입력한 신규 가맹점을 지우면 stock_ledger가
  // CASCADE로 통째로 사라졌다(재현됨). stores.id를 CASCADE로 참조하는 테이블 전부를 막는다.
  const [poRef, orderRef, userRef, ingredientRef, menuRef, salesRef, ledgerRef, adjustmentRef, wasteRef] = await Promise.all([
    knex('purchase_orders').where({ store_id: existing.id }).first(),
    knex('orders').where({ store_id: existing.id }).first(),
    knex('users').where({ store_id: existing.id }).first(),
    knex('ingredients').where({ store_id: existing.id }).first(),
    knex('menus').where({ store_id: existing.id }).first(),
    knex('sales_items').where({ store_id: existing.id }).first(),
    knex('stock_ledger').where({ store_id: existing.id }).first(),
    knex('stock_adjustments').where({ store_id: existing.id }).first(),
    knex('waste_logs').where({ store_id: existing.id }).first(),
  ]);
  if (poRef || orderRef || userRef || ingredientRef || menuRef || salesRef || ledgerRef || adjustmentRef || wasteRef) {
    return res.status(409).json({ error: '이 가맹점에는 발주·매출·재고 이력이 있어 삭제할 수 없습니다. 폐점 처리(is_open=false)를 이용해주세요' });
  }
  await knex('stores').where({ id: existing.id, brand_id: req.user.brand_id }).delete();
  await logAudit(req.user.brand_id, req.user.id, 'STORE', existing.id, 'DELETE', { name: existing.name }, null);
  res.json({ ok: true });
});

// 발주 마감시간이 다가오는데(또는 지났는데) 오늘 아직 발주를 제출하지 않은 가맹점 — 본사가 가맹점
// 하나하나 들어가보지 않아도 누락을 미리 잡을 수 있게 가맹점조회 화면에서 한눈에 보여주기 위함
router.get('/stores/order-status', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const stores = await knex('stores')
    .where({ brand_id: req.user.brand_id, is_open: true })
    .whereNotNull('order_deadline');
  if (stores.length === 0) return res.json([]);

  // purchase_orders.created_at은 knex.fn.now() 기본값(sqlite는 UTC 문자열)이라 서버 로컬 자정과
  // 비교하면 방언/타임존에 따라 "오늘"의 경계가 어긋난다 — dbStartOfKstToday()로 DB 타임스탬프 형식에 맞춘다.
  // 아래 마감시각 계산은 이미 KST인데 "오늘 발주했는가" 판정만 서버 로컬 자정이라, TZ 미설정
  // 환경에서 KST 00~09시 발주가 "오늘 발주"로 안 잡혔다.
  const todayStart = dbStartOfKstToday();
  const submittedToday = await knex('purchase_orders')
    .where('brand_id', req.user.brand_id)
    .whereNotIn('status', [ORDER_STATUSES.DRAFT, ORDER_STATUSES.CANCELED])
    .where('created_at', '>=', todayStart)
    .whereIn('store_id', stores.map(s => s.id))
    .select('store_id');
  const submittedStoreIds = new Set(submittedToday.map(o => o.store_id));

  const now = new Date();
  const todayDow = String(now.getDay());
  const result = stores
    .filter(s => !submittedStoreIds.has(s.id))
    // delivery_days가 설정된 가맹점은 오늘이 납품 가능 요일일 때만 노출 — 안 그러면 납품 안 하는
    // 요일에도 매일 "미발주"로 잘못 떠서 거짓 경보가 반복되고, 결국 진짜 누락도 무시하게 됨
    .filter(s => !s.delivery_days || s.delivery_days.split(',').filter(Boolean).includes(todayDow))
    .map(s => {
      const [h, m] = s.order_deadline.split(':').map(Number);
      // 운영 서버 TZ가 UTC라 서버 로컬 시각을 쓰면 KST 기준 마감시각과 9시간 어긋난다.
      // orders.js의 isPastOrderDeadline과 동일하게 KST로 고정한다.
      const kstNow = new Date(now.getTime() + 9 * 3600000);
      const kstDeadline = new Date(kstNow); kstDeadline.setUTCHours(h, m || 0, 0, 0);
      const diffMin = (kstDeadline.getTime() - kstNow.getTime()) / 60000;
      return { store_id: s.id, store_name: s.name, order_deadline: s.order_deadline, diffMin: Math.round(diffMin) };
    })
    .filter(r => r.diffMin <= 120); // 마감 2시간 이내거나 이미 지난 경우만 노출
  result.sort((a, b) => a.diffMin - b.diffMin);
  res.json(result);
});

// 재고 실사(StockAdjustment) 주기를 강제하는 게 없어서 "마지막 실사가 언제였는지"가 안 보이던 문제
// → 30일 넘게 실사 기록이 없는(또는 한 번도 없는) 가맹점을 가맹점조회 화면에서 바로 알 수 있게 함
router.get('/stores/audit-status', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const stores = await knex('stores').where({ brand_id: req.user.brand_id, is_open: true });
  if (stores.length === 0) return res.json([]);

  const lastAudits = await knex('stock_adjustments')
    .where('brand_id', req.user.brand_id)
    .whereIn('store_id', stores.map(s => s.id))
    .groupBy('store_id')
    .select('store_id').max('created_at as last_audit_at');
  const lastAuditByStore = new Map(lastAudits.map(r => [r.store_id, r.last_audit_at]));

  const result = stores.map(s => {
    const lastAuditAt = lastAuditByStore.get(s.id) || null;
    const daysSince = lastAuditAt ? Math.floor((Date.now() - new Date(lastAuditAt).getTime()) / 86400000) : null;
    return { store_id: s.id, store_name: s.name, lastAuditAt, daysSince };
  }).filter(r => r.daysSince === null || r.daysSince >= 30);
  result.sort((a, b) => (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity));
  res.json(result);
});

// 가맹점 결제내역 (토스포스 앱 "결제내역" 화면과 동일한 성격) — 취소된 주문은 orders.total_amount 등이
// 웹훅 취소 처리 때 0으로 비워지므로(재고 복구 로직 참고) raw_payload의 원본 금액/상품명을 그대로 사용해야
// 취소된 건도 원래 결제했던 금액·상품명이 화면에 그대로 보인다.
router.get('/stores/:id/payments', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const store = await knex('stores').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!store) return res.status(404).json({ error: '가맹점을 찾을 수 없습니다' });

  const { from, to } = req.query;
  const q = knex('orders').where({ store_id: store.id }).orderBy('processed_at', 'desc').limit(100);
  if (from) q.where('processed_at', '>=', from);
  if (to) q.where('processed_at', '<=', to);
  const rows = await q;

  const payments = rows.map(r => {
    let node = {};
    try { node = getOrderNode(JSON.parse(r.raw_payload)) || {}; } catch { node = {}; }
    const items = node.lineItems || [];
    const firstName = items[0]?.item?.title || items[0]?.name || '';
    const summary = !firstName ? '-' : items.length > 1 ? `${firstName} 등 총${items.length}건` : `${firstName} / 총1건`;
    const amount = Number(node.chargePrice?.totalAmount) || r.total_amount || 0;

    // 카드 결제 건이면 발급사명/카드번호를 보여줌 — cardNo는 API 문서상 마스킹 위치가 명확치 않아
    // (예시가 앞자리 노출/뒷자리 마스킹) 마스킹되지 않고 남아있는 숫자만 뽑아 그대로 표시한다
    const cardPayment = (node.payments || []).find(p => p.cardDetails);
    const cardDetails = cardPayment?.cardDetails;
    const cardDigits = cardDetails?.cardNo ? cardDetails.cardNo.replace(/[^0-9]/g, '') : '';
    const cardLabel = cardDetails ? [cardDetails.cardBrand, cardDigits].filter(Boolean).join(' ') : null;

    return {
      id: r.id,
      processed_at: r.processed_at,
      summary,
      amount,
      cardLabel,
      status: r.order_state === 'CANCELLED' ? 'CANCELLED' : r.order_state === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
    };
  });
  res.json(payments);
});

// 본사 직원이 담당하는 가맹점 중 처리해야 할 일(미확인 변경알림, 검토대기 발주, 미처리 리스크)을
// 모아서 보여줌 — 브랜드 전체 화면만 있어서 "내가 담당하는 것만" 빠르게 훑어볼 방법이 없었음
router.get('/my-tasks', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const myStores = await knex('stores').where({ brand_id: req.user.brand_id, assigned_user_id: req.user.id });
  if (myStores.length === 0) return res.json({ stores: [] });
  const storeIds = myStores.map(s => s.id);

  const orders = await knex('purchase_orders')
    .where('brand_id', req.user.brand_id).whereIn('store_id', storeIds)
    .where(function () {
       this.whereIn('status', [ORDER_STATUSES.ORDERED, ORDER_STATUSES.REVIEWING]).orWhere('needs_attention', true);
    });
  const risks = await knex('risk_alerts')
    .where({ brand_id: req.user.brand_id, status: RISK_STATUSES.OPEN }).whereIn('store_id', storeIds);
  const receiptIssues = await knex('purchase_orders')
    .where('brand_id', req.user.brand_id).whereIn('store_id', storeIds)
    .whereNotNull('receipt_issue_note').whereNull('receipt_issue_resolved_at');

  const result = myStores.map(s => ({
    store_id: s.id, store_name: s.name,
    pendingReview: orders.filter(o => o.store_id === s.id && [ORDER_STATUSES.ORDERED, ORDER_STATUSES.REVIEWING].includes(o.status)).length,
    needsAttention: orders.filter(o => o.store_id === s.id && o.needs_attention).length,
    openRisks: risks.filter(r => r.store_id === s.id).length,
    receiptIssues: receiptIssues.filter(r => r.store_id === s.id).length,
  }));
  res.json({ stores: result });
});

// ─── 재료 ───────────────────────────────────────────
router.get('/ingredients', requireAuth, async (req, res) => {
  const { store_id } = req.query;
  // 가맹점 역할은 쿼리파라미터로 다른 가맹점을 조회할 수 없도록 강제
  const isStoreRole = ['STORE_OWNER', 'STORE_STAFF'].includes(req.user.role);
  if (isStoreRole && !req.user.store_id) return res.json([]); // 소속 가맹점이 없으면 전체 브랜드 데이터가 노출되지 않도록 빈 목록 반환
  const sid = isStoreRole ? req.user.store_id : (store_id || req.user.store_id);
  const q = knex('ingredients').where({ brand_id: req.user.brand_id }).orderBy('name');
  if (sid) {
    // 가맹점 전용 재료 + 같은 이름의 가맹점 전용이 없는 브랜드 공통 재료만 반환 (중복 제거)
    q.where(function () {
      this.where({ store_id: sid }).orWhere(function () {
        this.whereNull('store_id').whereNotIn('name',
          knex('ingredients').where({ brand_id: req.user.brand_id, store_id: sid }).select('name')
        );
      });
    });
  }
  res.json(await q);
});

router.post('/ingredients', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const { name, unit, stock, threshold, store_id, order_unit, order_unit_conversion } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '재료명을 입력해주세요' });
  if ((stock !== undefined && Number(stock) < 0) || (threshold !== undefined && Number(threshold) < 0)) {
    return res.status(400).json({ error: '재고와 알림 기준은 0 이상이어야 합니다' });
  }
  if (store_id) {
    const store = await knex('stores').where({ id: store_id, brand_id: req.user.brand_id }).first();
    if (!store) return res.status(400).json({ error: '존재하지 않는 가맹점입니다' });
  }
  const [{ id }] = await knex('ingredients').insert({
    brand_id: req.user.brand_id,
    store_id: store_id || req.user.store_id,
    name, unit,
    stock: stock ?? 0,
    threshold: threshold ?? 0,
    order_unit: order_unit || null,
    order_unit_conversion: order_unit_conversion || null,
  }).returning('id');
  res.json({ id });
});

router.put('/ingredients/:id', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const existing = await knex('ingredients').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  const { name, unit, stock, threshold, order_unit, order_unit_conversion, is_key } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: '재료명을 입력해주세요' });
  if ((stock !== undefined && Number(stock) < 0) || (threshold !== undefined && Number(threshold) < 0)) {
    return res.status(400).json({ error: '재고와 알림 기준은 0 이상이어야 합니다' });
  }
  const newStock = stock ?? existing.stock;
  // stock이 요청에 아예 없는 경우(이름만 바꾸는 등)는 물론, 값이 왔어도 기존과 같으면(변동 0)
  // 수불부에 남기지 않는다 — 실제 재고 변동이 없는 PUT 호출까지 매번 기록하면 수불부가
  // "재고가 언제 얼마나 들고 났는지"가 아니라 "이 API가 언제 불렸는지" 로그가 돼버려
  // /stock/ledger 화면의 신호 대 잡음비가 나빠진다.
  const stockChanged = stock !== undefined && Number(newStock) !== Number(existing.stock);
  await knex.transaction(async (trx) => {
    await trx('ingredients').where({ id: req.params.id, brand_id: req.user.brand_id })
      .update({
        name: name ?? existing.name,
        unit: unit ?? existing.unit,
        stock: newStock,
        threshold: threshold ?? existing.threshold,
        order_unit: order_unit ?? existing.order_unit,
        order_unit_conversion: order_unit_conversion ?? existing.order_unit_conversion,
        is_key: is_key !== undefined ? (is_key ? 1 : 0) : existing.is_key,
      });
    if (stockChanged) {
      // 이 경로는 실사 조정(POST /stock/adjustments)처럼 "관찰/파악한 값으로 재고를 절대값으로
      // 덮어쓴다"는 점에서 ADJUSTMENT와 성격이 같다 — 판매/납품/폐기처럼 업무 이벤트에 딸린
      // 증감이 아니라 담당자가 직접 옳다고 판단한 수치로 맞추는 보정이기 때문. stock_adjustments
      // 테이블(사유 입력 UI)을 거치지 않는 더 간단한 경로라 ref_type/ref_id는 남기지 않는다.
      await logStockMovement(trx, {
        brand_id: req.user.brand_id, store_id: existing.store_id, ingredient_id: existing.id,
        type: STOCK_LEDGER_TYPES.ADJUSTMENT, delta: Number(newStock) - Number(existing.stock),
        before_stock: existing.stock, after_stock: Number(newStock),
        memo: `재고 직접 수정 (담당자, ${existing.stock} → ${newStock})`, created_by: req.user.id,
      });
    }
  });
  res.json({ ok: true });
});

router.delete('/ingredients/:id', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const existing = await knex('ingredients').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  // 예전엔 조건 없이 delete라 stock_ledger가 FK CASCADE로 통째로 지워져 수불부 이력이 소실됐다.
  // products.ingredient_id는 SET NULL이라 상품만 연결된 재료를 지우면 연결이 조용히 끊기고,
  // 이후 납품 시 applyItemStock이 같은 이름의 재료를 새로 만들어 재고가 두 갈래로 갈린다(재현됨).
  const [ledger, recipeRef, wasteRef, productRef, adjustmentRef, recipeHistoryRef] = await Promise.all([
    knex('stock_ledger').where({ ingredient_id: existing.id }).first(),
    knex('recipes').where({ ingredient_id: existing.id }).first(),
    knex('waste_logs').where({ ingredient_id: existing.id }).first(),
    knex('products').where({ ingredient_id: existing.id }).first(),
    knex('stock_adjustments').where({ ingredient_id: existing.id }).first(),
    knex('recipe_history').where({ ingredient_id: existing.id }).first(),
  ]);
  if (ledger || recipeRef || wasteRef || productRef || adjustmentRef || recipeHistoryRef) {
    return res.status(409).json({ error: '이 재료에는 수불/레시피/폐기/실사 이력이 있거나 발주 상품이 연결되어 있어 삭제할 수 없습니다. 사용을 중단하려면 레시피와 상품 연결에서 먼저 제외해주세요' });
  }
  await knex('ingredients').where({ id: existing.id, brand_id: req.user.brand_id }).delete();
  await logAudit(req.user.brand_id, req.user.id, 'INGREDIENT', existing.id, 'DELETE', { name: existing.name, stock: existing.stock }, null);
  res.json({ ok: true });
});

router.post('/ingredients/:id/restock', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const { amount } = req.body;
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: '입고량은 0보다 큰 값이어야 합니다' });
  }
  const found = await knex.transaction(async (trx) => {
    const ingredient = await trx('ingredients').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
    if (!ingredient) return false;
    const before = ingredient.stock || 0;
    await trx('ingredients').where({ id: ingredient.id }).increment('stock', amt);
    // 정식 발주(purchase_order) 없이 담당자가 그 자리에서 입력하는 간편 입고라 엮을 발주 건이
    // 없다 — 그래도 물리적으로는 "재고가 늘어난 입고"이므로 발주 납품과 같은 DELIVERY 타입으로
    // 남긴다(STOCK_LEDGER_TYPES에 수동 입고 전용 타입은 따로 없고, 이번 작업은 constants.js를
    // 건드리지 않는 범위다). increment는 원자적이라 이 사이 다른 트랜잭션이 같은 재료의 재고를
    // 바꿔도 lost-update가 없고, amt가 정확히 얼마나 늘렸는지도 알고 있으므로 재조회 없이
    // before+amt로 after_stock을 계산해도 안전하다.
    await logStockMovement(trx, {
      brand_id: req.user.brand_id, store_id: ingredient.store_id, ingredient_id: ingredient.id,
      type: STOCK_LEDGER_TYPES.DELIVERY, delta: amt, before_stock: before, after_stock: before + amt,
      memo: `간편 입고 (담당자 직접 입력, +${amt})`, created_by: req.user.id,
    });
    return true;
  });
  if (!found) return res.status(404).json({ error: '없음' });
  res.json({ ok: true });
});

// ─── 메뉴 ───────────────────────────────────────────
router.get('/menus', requireAuth, async (req, res) => {
  const { store_id } = req.query;
  const isStoreRole = ['STORE_OWNER', 'STORE_STAFF'].includes(req.user.role);
  if (isStoreRole && !req.user.store_id) return res.json([]); // 소속 가맹점이 없으면 전체 브랜드 데이터가 노출되지 않도록 빈 목록 반환
  const sid = isStoreRole ? req.user.store_id : (store_id || req.user.store_id);
  const q = knex('menus').where({ brand_id: req.user.brand_id }).orderBy('name');
  if (sid) q.where({ store_id: sid });
  const menus = await q;
  // 메뉴마다 recipes.filter를 돌리면 메뉴 수(N)×레시피 수(M)로 커지므로, menuId로 whereIn 조회 후
  // 한 번만 그룹핑한다.
  const menuIds = menus.map(m => m.id);
  const recipes = menuIds.length
    ? await knex('recipes')
        .join('ingredients', 'recipes.ingredient_id', 'ingredients.id')
        .select('recipes.*', 'ingredients.name as ingredient_name', 'ingredients.unit')
        .whereIn('recipes.menu_id', menuIds)
    : [];
  const byMenu = new Map();
  for (const r of recipes) {
    if (!byMenu.has(r.menu_id)) byMenu.set(r.menu_id, []);
    byMenu.get(r.menu_id).push(r);
  }
  res.json(menus.map(m => ({ ...m, recipes: byMenu.get(m.id) || [] })));
});

router.post('/menus', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const { name, toss_menu_id, store_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '메뉴명을 입력해주세요' });
  if (store_id) {
    const store = await knex('stores').where({ id: store_id, brand_id: req.user.brand_id }).first();
    if (!store) return res.status(400).json({ error: '존재하지 않는 가맹점입니다' });
  }
  const [{ id }] = await knex('menus').insert({
    brand_id: req.user.brand_id,
    store_id: store_id || req.user.store_id,
    name, toss_menu_id: toss_menu_id || null,
  }).returning('id');
  res.json({ id });
});

// 여러 매장 메뉴를 한 번에 표준 메뉴에 연결/해제한다(recipe_source_menu_id). 화면에서 메뉴 수십
// 개를 훑으며 하나씩 저장하면 매번 왕복이 걸려 느려지므로 배열로 한 번에 받는다.
// 주의: 반드시 아래 PUT /menus/:id보다 먼저 등록해야 한다 — express는 등록 순서대로 매칭하므로,
// 이 라우트가 뒤에 있으면 PUT /menus/:id의 :id가 "recipe-links" 문자열을 그대로 삼켜버려(메뉴
// id="recipe-links"로 조회 시도 → 404) 이 라우트가 영영 호출되지 않는다(직접 재현해서 확인함).
router.put('/menus/recipe-links', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const { links } = req.body;
  if (!Array.isArray(links) || links.length === 0) {
    return res.status(400).json({ error: 'links 배열이 필요합니다' });
  }
  const brand_id = req.user.brand_id;

  const brandMenus = await knex('menus').where({ brand_id }).select('id', 'recipe_source_menu_id');
  const brandMenuIds = new Set(brandMenus.map(m => m.id));
  const beforeById = new Map(brandMenus.map(m => [m.id, m.recipe_source_menu_id]));

  const normalized = [];
  for (const link of links) {
    const menuId = Number(link.menu_id);
    if (!Number.isFinite(menuId) || !brandMenuIds.has(menuId)) {
      return res.status(400).json({ error: `존재하지 않거나 다른 브랜드의 메뉴입니다: menu_id=${link.menu_id}` });
    }
    let sourceId = null;
    if (link.recipe_source_menu_id != null) {
      sourceId = Number(link.recipe_source_menu_id);
      // 브랜드 스코프 확인 — 다른 브랜드의 메뉴를 표준 메뉴로 가리키면 그 브랜드의 레시피가 이
      // 브랜드 매장의 재고를 차감하게 되는 심각한 오염이라 반드시 막아야 한다.
      if (!Number.isFinite(sourceId) || !brandMenuIds.has(sourceId)) {
        return res.status(400).json({ error: `존재하지 않거나 다른 브랜드의 표준 메뉴입니다: recipe_source_menu_id=${link.recipe_source_menu_id}` });
      }
      if (sourceId === menuId) {
        return res.status(400).json({ error: `메뉴가 자기 자신을 표준 메뉴로 가리킬 수 없습니다: menu_id=${menuId}` });
      }
    }
    normalized.push({ menuId, sourceId });
  }

  // 사이클 검증 — 배치 전체를 한 그래프에 함께 반영한 뒤 검사해야, 이번 배치 안에서 두 메뉴가
  // 서로를 가리키게 되는 경우(A→B, B→A를 같은 요청에 같이 보낸 경우)도 잡을 수 있다.
  const graph = await buildMenuEdgeGraph(brand_id);
  for (const { menuId, sourceId } of normalized) {
    graph.set(menuId, sourceId != null ? new Set([sourceId]) : new Set());
  }
  for (const { menuId, sourceId } of normalized) {
    if (sourceId == null) continue; // 해제는 사이클을 새로 만들 수 없다
    if (hasCycleFrom(graph, menuId)) {
      return res.status(400).json({ error: `순환 참조가 감지되어 저장할 수 없습니다: menu_id=${menuId}이(가) 표준 메뉴 연결을 따라가다 다시 자기 자신으로 돌아옵니다` });
    }
  }

  await knex.transaction(async (trx) => {
    for (const { menuId, sourceId } of normalized) {
      await trx('menus').where({ id: menuId, brand_id }).update({ recipe_source_menu_id: sourceId });
    }
  });
  // logAudit은 트랜잭션 인자(trx)가 아니라 항상 require된 knex를 직접 쓴다(auditLog.js) — SQLite는
  // 커넥션 풀이 1개뿐이라 이미 열린 트랜잭션 안에서 부르면 서로 커넥션을 기다리다 교착 상태에
  // 빠진다(CLAUDE.md 4절). 그래서 트랜잭션이 커밋된 뒤에만 호출한다.
  for (const { menuId, sourceId } of normalized) {
    await logAudit(brand_id, req.user.id, 'MENU_RECIPE_LINK', menuId, 'UPDATE',
      { recipe_source_menu_id: beforeById.get(menuId) ?? null }, { recipe_source_menu_id: sourceId });
  }
  res.json({ ok: true, updated: normalized.length });
});

router.put('/menus/:id', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const existing = await knex('menus').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  const { name, toss_menu_id, is_active, is_key } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: '메뉴명을 입력해주세요' });
  await knex('menus').where({ id: req.params.id, brand_id: req.user.brand_id }).update({
    name: name ?? existing.name,
    toss_menu_id: toss_menu_id ?? existing.toss_menu_id,
    is_active: is_active !== undefined ? is_active : existing.is_active,
    is_key: is_key !== undefined ? (is_key ? 1 : 0) : existing.is_key,
  });
  res.json({ ok: true });
});

router.delete('/menus/:id', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  await knex('menus').where({ id: req.params.id, brand_id: req.user.brand_id }).delete();
  res.json({ ok: true });
});

// ─── 레시피 ──────────────────────────────────────────
router.post('/menus/:menuId/recipes', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const menu = await knex('menus').where({ id: req.params.menuId, brand_id: req.user.brand_id }).first();
  if (!menu) return res.status(404).json({ error: '없음' });
  const { ingredient_id, amount } = req.body;
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    // 0 이하 값은 예상 소진량 계산에서 비율이 null이 되어 과다사입 리스크 감지가 조용히 무력화되므로 차단
    return res.status(400).json({ error: '사용량은 0보다 큰 값이어야 합니다' });
  }
  const existing = await knex('recipes').where({ menu_id: req.params.menuId, ingredient_id }).first();
  const ing = await knex('ingredients').where({ id: ingredient_id, brand_id: req.user.brand_id }).first();
  if (!ing) return res.status(400).json({ error: '재료를 찾을 수 없습니다' });
  // 재료가 이 메뉴와 같은 가맹점 소속이거나 브랜드 공통(store_id NULL)일 때만 허용 — A점 메뉴
  // 레시피에 B점 재료를 걸면 A점에서 팔릴 때마다 B점 재고가 깎이고 수불부는 A점에 기록돼,
  // 양쪽 장부가 동시에 틀어진다.
  if (ing.store_id != null && menu.store_id != null && ing.store_id !== menu.store_id) {
    return res.status(400).json({ error: '다른 가맹점의 재료는 이 메뉴의 레시피에 등록할 수 없습니다' });
  }
  if (existing) {
    await knex('recipe_history').insert({ menu_id: req.params.menuId, ingredient_id, ingredient_name: ing?.name, old_amount: existing.amount, new_amount: amount, action: 'UPDATED', changed_by: req.user.id });
  } else {
    await knex('recipe_history').insert({ menu_id: req.params.menuId, ingredient_id, ingredient_name: ing?.name, old_amount: null, new_amount: amount, action: 'ADDED', changed_by: req.user.id });
  }
  await knex('recipes').insert({ menu_id: req.params.menuId, ingredient_id, amount }).onConflict(['menu_id', 'ingredient_id']).merge();
  res.json({ ok: true });
});

router.delete('/menus/:menuId/recipes/:ingredientId', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const menu = await knex('menus').where({ id: req.params.menuId, brand_id: req.user.brand_id }).first();
  if (!menu) return res.status(404).json({ error: '없음' });
  const existing = await knex('recipes').where({ menu_id: req.params.menuId, ingredient_id: req.params.ingredientId }).first();
  const ing = await knex('ingredients').where({ id: req.params.ingredientId }).first();
  if (existing) {
    await knex('recipe_history').insert({ menu_id: req.params.menuId, ingredient_id: req.params.ingredientId, ingredient_name: ing?.name, old_amount: existing.amount, new_amount: null, action: 'DELETED', changed_by: req.user.id });
  }
  await knex('recipes').where({ menu_id: req.params.menuId, ingredient_id: req.params.ingredientId }).delete();
  res.json({ ok: true });
});

router.get('/menus/:menuId/recipe-history', requireAuth, async (req, res) => {
  // menu_id는 브랜드 간 공유되지 않는 PK이므로, 다른 브랜드의 menuId를 넣으면 그 브랜드의 레시피 변경 이력(재료 사용량, 변경자 등)이 그대로 노출됨 — 소속 브랜드 메뉴인지 먼저 확인
  const menu = await knex('menus').where({ id: req.params.menuId, brand_id: req.user.brand_id }).first();
  if (!menu) return res.status(404).json({ error: '없음' });
  const rows = await knex('recipe_history as rh')
    .leftJoin('users as u', 'rh.changed_by', 'u.id')
    .select('rh.*', 'u.name as changed_by_name')
    .where('rh.menu_id', req.params.menuId)
    .orderBy('rh.created_at', 'desc')
    .limit(50);
  res.json(rows);
});

// ─── 레시피 지정 필요 / 표준 메뉴 연결 / 세트 구성 ─────────
// 워크플로: 본사가 표준 메뉴("아메리카노"→원두 20g)를 한 번 등록해두면, 매장별로 판매 유입 중
// 자동 생성된(auto_discovered) 메뉴나 아직 레시피가 없는 메뉴를 이 표준 메뉴에 연결
// (recipe_source_menu_id)하거나 세트 구성(menu_components)으로 묶는 것만으로 그 메뉴도 재고가
// 자동 차감되기 시작한다. 아래는 그 연결 작업을 지원하는 라우트들이다.

// 한국어 메뉴명 정규화 + 유사도 추천 ──────────────────────
// 공백/특수문자 제거, 영문 대소문자 통일, 자주 붙는 온도 수식어 제거까지만 한다. 수식어를 무조건
// 통째로 지우면 "아이스크림"처럼 그 자체가 하나의 단어인 이름을 잘못 잘라낼 위험이 있어, 정규화된
// 문자열의 접두/접미 위치에 있을 때만 제거한다(POS 메뉴명은 대부분 "ICE아메리카노"/"아메리카노HOT"
// 처럼 수식어가 양 끝에 붙는 관례를 따른다). 길이가 긴 수식어를 먼저 검사해야 한다 — "ICE"가
// "ICED"보다 먼저 매칭되면 "D"가 이름에 남는 사고가 난다.
const NAME_MODIFIERS = ['ICED', 'ICE', 'HOT', 'WARM', '아이스', '따뜻한', '뜨거운', '핫', '냉', '온'];
function stripModifiers(name) {
  let s = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const mod of NAME_MODIFIERS) {
      if (s.startsWith(mod) && s.length > mod.length) { s = s.slice(mod.length); changed = true; }
      if (s.endsWith(mod) && s.length > mod.length) { s = s.slice(0, -mod.length); changed = true; }
    }
  }
  return s;
}
function normalizeMenuName(name) {
  if (!name) return '';
  return name.replace(/[\s\-_.,()[\]·/]+/g, '').toUpperCase();
}
// 2-gram(bigram) 기준 Dice 유사도 — 완전히 다른 메뉴명이 우연히 한두 글자만 겹쳐 높은 점수를
// 받는 것을 막기 위해 2자 미만인 문자열은 완전 일치가 아니면 0으로 취급한다.
function bigrams(s) {
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}
function diceSimilarity(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ga = bigrams(a), gb = bigrams(b);
  const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of gb) {
    const c = counts.get(g) || 0;
    if (c > 0) { overlap++; counts.set(g, c - 1); }
  }
  return (2 * overlap) / (ga.length + gb.length);
}
// 확신도가 낮으면 추천하지 않는다 — 틀린 추천은 없는 추천보다 나쁘다(본사가 그대로 확정해버리기
// 쉽다). 3단계로 점수를 매긴다:
//   1) 수식어까지 뗀 뒤 완전히 같으면(예: "ICE아메"→"아메" == "아메리카노"의 core는 다르므로 이
//      단계는 진짜 동일 이름일 때만, 예: "ICE라떼" vs "HOT라떼") 만점(1.0).
//   2) 수식어를 뗀 두 이름이 포함 관계면(예: "아메" ⊂ "아메리카노", "라떼" ⊂ "카페라떼") — 한국
//      매장이 표준 메뉴 이름을 줄여 부르는 흔한 패턴 — 0.7~0.95, 짧은 쪽이 긴 쪽에서 차지하는
//      비율이 클수록 높은 점수.
//   3) 그 외엔 bigram 유사도를 쓰되 0.6 미만이면 후보에서 아예 제외한다.
const MIN_SUGGESTION_SCORE = 0.6;
const MAX_SUGGESTIONS = 3;
function suggestRecipeSource(menuName, standardMenus) {
  const clean = normalizeMenuName(menuName);
  const core = stripModifiers(clean);
  const scored = [];
  for (const sm of standardMenus) {
    const smClean = normalizeMenuName(sm.name);
    const smCore = stripModifiers(smClean);
    let score = 0;
    let basis = null;
    if (core && smCore && core === smCore) {
      score = 1;
      basis = 'exact';
    } else if (core.length >= 2 && smCore.length >= 2 && (core.includes(smCore) || smCore.includes(core))) {
      const shorter = Math.min(core.length, smCore.length);
      const longer = Math.max(core.length, smCore.length);
      score = 0.7 + 0.25 * (shorter / longer);
      basis = 'contains';
    } else {
      const sim = diceSimilarity(core, smCore);
      if (sim >= MIN_SUGGESTION_SCORE) { score = sim; basis = 'similar'; }
    }
    if (score >= MIN_SUGGESTION_SCORE) {
      scored.push({ menu_id: sm.id, menu_name: sm.name, score: Math.round(score * 100) / 100, basis });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SUGGESTIONS);
}

// 본사가 매장별로 아직 정리 안 된 메뉴를 보는 목록 — 레시피도, 표준 메뉴 연결도, 세트 구성도
// 전부 없는 메뉴는 팔려도 재고가 한 톨도 안 깎인다.
router.get('/menus/unassigned', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const brand_id = req.user.brand_id;
  const { store_id, days } = req.query;
  const lookbackDays = Number(days) > 0 ? Number(days) : 30;
  const sinceISO = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  // 레시피도 없고(recipes) 표준 메뉴 연결도 없고(recipe_source_menu_id) 세트 구성도 없는
  // (menu_components) 매장 메뉴 = menuResolver가 "아무것도 못 찾음"으로 판정해 빈 배열을 돌려주는
  // 것과 정확히 같은 조건이다. 메뉴 수만큼 resolveConsumption을 호출하는 대신, 조건이 단순해
  // SQL로 직접 걸러 쿼리 1번으로 끝낸다.
  const q = knex('menus as m')
    .join('stores as s', 'm.store_id', 's.id')
    .where('m.brand_id', brand_id)
    .whereNotNull('m.store_id') // 브랜드 표준 메뉴(store_id NULL) 자신은 연결의 "목적지"이지 대상이 아니다
    .whereNull('m.recipe_source_menu_id')
    .whereNotExists(knex('recipes').whereRaw('recipes.menu_id = m.id'))
    .whereNotExists(knex('menu_components').whereRaw('menu_components.set_menu_id = m.id'))
    .select('m.id', 'm.name', 'm.toss_menu_id', 'm.auto_discovered', 'm.is_active', 'm.store_id', 's.name as store_name');
  if (store_id) q.where('m.store_id', Number(store_id));
  const unassigned = await q;

  if (unassigned.length === 0) return res.json({ menus: [], period: { from: sinceISO }, lookback_days: lookbackDays });

  // 최근 판매량 — sales_items에는 menu_id가 없어(menu_name/toss_menu_id로만 기록) 매장별로 다시
  // 매칭해야 한다. 매장마다 메뉴 집합이 다르므로 store_id 단위로 인덱스를 나눠 동명 메뉴가 다른
  // 매장 것과 섞이지 않게 한다.
  const storeIds = [...new Set(unassigned.map(m => m.store_id))];
  const salesRows = await knex('sales_items')
    .where({ brand_id })
    .whereIn('store_id', storeIds)
    .where('sold_at', '>=', sinceISO)
    .select('store_id', 'menu_name', 'toss_menu_id',
      knex.raw('SUM(quantity) as qty'), knex.raw('SUM(amount) as amount'), knex.raw('COUNT(DISTINCT toss_order_id) as order_count'))
    .groupBy('store_id', 'menu_name', 'toss_menu_id');

  const indexByStore = new Map(storeIds.map(sid => [sid, buildMenuIndex(unassigned.filter(m => m.store_id === sid))]));
  const salesByMenuId = new Map();
  for (const row of salesRows) {
    const index = indexByStore.get(row.store_id);
    const menu = index && matchMenu(index, row.toss_menu_id, row.menu_name);
    if (!menu) continue; // 이미 레시피가 있는(=미지정 목록에 없는) 메뉴로 팔린 판매 — 이 목록의 대상이 아님
    const prev = salesByMenuId.get(menu.id) || { qty: 0, amount: 0, order_count: 0 };
    salesByMenuId.set(menu.id, {
      qty: prev.qty + Number(row.qty), amount: prev.amount + Number(row.amount), order_count: prev.order_count + Number(row.order_count),
    });
  }

  // 추천 대상 — 브랜드 표준 메뉴(store_id NULL) 중 실제로 레시피가 있는 것만. 레시피 없는 표준
  // 메뉴를 추천해봤자 연결해도 여전히 소진량 0이라 의미가 없다.
  const standardMenus = await knex('menus as m')
    .where('m.brand_id', brand_id).whereNull('m.store_id')
    .whereExists(knex('recipes').whereRaw('recipes.menu_id = m.id'))
    .select('m.id', 'm.name');

  const result = unassigned.map(m => {
    const sales = salesByMenuId.get(m.id) || { qty: 0, amount: 0, order_count: 0 };
    return {
      menu_id: m.id, menu_name: m.name, store_id: m.store_id, store_name: m.store_name,
      toss_menu_id: m.toss_menu_id, auto_discovered: !!m.auto_discovered, is_active: !!m.is_active,
      recent_sales_qty: sales.qty, recent_sales_amount: sales.amount, recent_order_count: sales.order_count,
      suggestions: suggestRecipeSource(m.name, standardMenus),
    };
  });
  // 많이 팔리는데 미지정인 메뉴일수록 재고 왜곡이 크다 — 본사가 우선순위를 판단할 때 가장 급한
  // 것부터 보이게 정렬한다.
  result.sort((a, b) => b.recent_sales_qty - a.recent_sales_qty);

  res.json({ menus: result, period: { from: sinceISO }, lookback_days: lookbackDays });
});

// recipe_source_menu_id 포인터 + menu_components 소속 관계를 하나의 그래프로 합쳐서 사이클을
// 검사한다. menuResolver.walk()가 계산 때 두 종류의 엣지를 모두 따라가므로(menuResolver.js 규칙
// 2·3), 저장 시점 검증도 반드시 둘을 합친 그래프에서 해야 한다 — 한쪽만 보면 recipe_source_menu_id
// 로 만든 참조와 menu_components로 만든 참조가 서로를 가리켜 만드는 사이클(예: A가 B를 표준 메뉴로
// 가리키는데 B가 세트로 A를 포함)을 놓친다. menuResolver는 런타임에 이런 사이클을 감지해 예외를
// 던지지만, 그 시점이면 이미 그 메뉴를 파는 매장의 사입 계산이 통째로 실패한 뒤다 — 저장 자체를
// 막는 편이 맞다.
async function buildMenuEdgeGraph(brand_id) {
  const sourceEdges = await knex('menus').where({ brand_id }).whereNotNull('recipe_source_menu_id').select('id', 'recipe_source_menu_id');
  const componentEdges = await knex('menu_components').where({ brand_id }).select('set_menu_id', 'component_menu_id');
  const graph = new Map(); // menu_id -> Set(다음 menu_id들)
  const addEdge = (from, to) => {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from).add(to);
  };
  for (const e of sourceEdges) addEdge(e.id, e.recipe_source_menu_id);
  for (const e of componentEdges) addEdge(e.set_menu_id, e.component_menu_id);
  return graph;
}
// startId에서 출발해 graph를 따라가다 다시 startId로 돌아오면 사이클. 저장 전 검증이라 성능보다
// 정확성이 우선이지만, 사이클은 아니되 비정상적으로 긴 체인(잘못 등록된 데이터)에 대비해
// menuResolver.js와 같은 취지의 깊이 상한을 둔다.
const CYCLE_CHECK_MAX_DEPTH = 50;
function hasCycleFrom(graph, startId) {
  const visited = new Set();
  const stack = [[startId, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (depth > CYCLE_CHECK_MAX_DEPTH) return true; // 비정상적으로 긴 체인 — 안전하게 사이클로 간주해 차단
    for (const next of (graph.get(node) || [])) {
      if (next === startId) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push([next, depth + 1]);
    }
  }
  return false;
}

// 세트 구성(menu_components) 조회/등록/수정/삭제
router.get('/menus/:menuId/components', requireAuth, async (req, res) => {
  const menu = await knex('menus').where({ id: req.params.menuId, brand_id: req.user.brand_id }).first();
  if (!menu) return res.status(404).json({ error: '없음' });
  const rows = await knex('menu_components as mc')
    .join('menus as m', 'mc.component_menu_id', 'm.id')
    .select('mc.id', 'mc.component_menu_id', 'mc.quantity', 'm.name as component_menu_name')
    .where('mc.set_menu_id', req.params.menuId);
  res.json(rows);
});

router.post('/menus/:menuId/components', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const menu = await knex('menus').where({ id: req.params.menuId, brand_id: req.user.brand_id }).first();
  if (!menu) return res.status(404).json({ error: '없음' });
  const { component_menu_id, quantity } = req.body;
  const componentId = Number(component_menu_id);
  if (!Number.isFinite(componentId)) return res.status(400).json({ error: '구성 메뉴를 선택해주세요' });
  if (componentId === menu.id) return res.status(400).json({ error: '세트가 자기 자신을 구성 메뉴로 포함할 수 없습니다' });
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    return res.status(400).json({ error: '수량은 0보다 큰 값이어야 합니다' });
  }
  // 브랜드 스코프 확인 — 다른 브랜드의 메뉴를 세트 구성으로 넣으면 그 브랜드 레시피가 이 브랜드
  // 매장 재고를 차감하게 된다.
  const component = await knex('menus').where({ id: componentId, brand_id: req.user.brand_id }).first();
  if (!component) return res.status(400).json({ error: '존재하지 않거나 다른 브랜드의 메뉴입니다' });

  // 사이클 검증 — 이 세트(menu.id)가 componentId를 포함하는 엣지를 추가한 뒤에도 자기 자신으로
  // 돌아오는 경로가 생기지 않아야 한다. recipe_source_menu_id 포인터도 같은 그래프에서 함께 본다.
  const graph = await buildMenuEdgeGraph(req.user.brand_id);
  if (!graph.has(menu.id)) graph.set(menu.id, new Set());
  graph.get(menu.id).add(componentId);
  if (hasCycleFrom(graph, menu.id)) {
    return res.status(400).json({
      error: `순환 참조가 감지되어 저장할 수 없습니다: "${menu.name}"이(가) "${component.name}"을(를) 포함하면 구성/표준메뉴 연결을 따라가다 다시 "${menu.name}"으로 돌아옵니다`,
    });
  }

  await knex('menu_components').insert({
    brand_id: req.user.brand_id, set_menu_id: menu.id, component_menu_id: componentId, quantity,
  }).onConflict(['set_menu_id', 'component_menu_id']).merge();
  await logAudit(req.user.brand_id, req.user.id, 'MENU_COMPONENT', menu.id, 'UPSERT', null, { component_menu_id: componentId, quantity });
  res.json({ ok: true });
});

router.put('/menus/:menuId/components/:componentMenuId', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const menu = await knex('menus').where({ id: req.params.menuId, brand_id: req.user.brand_id }).first();
  if (!menu) return res.status(404).json({ error: '없음' });
  const { quantity } = req.body;
  if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
    return res.status(400).json({ error: '수량은 0보다 큰 값이어야 합니다' });
  }
  const existing = await knex('menu_components').where({ set_menu_id: req.params.menuId, component_menu_id: req.params.componentMenuId }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  await knex('menu_components').where({ id: existing.id }).update({ quantity });
  await logAudit(req.user.brand_id, req.user.id, 'MENU_COMPONENT', menu.id, 'UPDATE',
    { component_menu_id: existing.component_menu_id, quantity: existing.quantity },
    { component_menu_id: existing.component_menu_id, quantity });
  res.json({ ok: true });
});

router.delete('/menus/:menuId/components/:componentMenuId', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const menu = await knex('menus').where({ id: req.params.menuId, brand_id: req.user.brand_id }).first();
  if (!menu) return res.status(404).json({ error: '없음' });
  const existing = await knex('menu_components').where({ set_menu_id: req.params.menuId, component_menu_id: req.params.componentMenuId }).first();
  await knex('menu_components').where({ set_menu_id: req.params.menuId, component_menu_id: req.params.componentMenuId }).delete();
  if (existing) {
    await logAudit(req.user.brand_id, req.user.id, 'MENU_COMPONENT', menu.id, 'DELETE',
      { component_menu_id: existing.component_menu_id, quantity: existing.quantity }, null);
  }
  res.json({ ok: true });
});

// ─── 대시보드 ─────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  const { store_id } = req.query;
  const isStoreRole = ['STORE_OWNER', 'STORE_STAFF'].includes(req.user.role);
  // 가맹점 역할 계정에 소속 가맹점이 없으면 브랜드 전체 데이터가 보이지 않도록 차단
  if (isStoreRole && !req.user.store_id) return res.status(400).json({ error: '소속 가맹점 정보가 없습니다. 관리자에게 문의해주세요' });
  const sid = isStoreRole ? req.user.store_id : (store_id || req.user.store_id);
  const brand_id = req.user.brand_id;

  const ingQ = knex('ingredients as i')
    .leftJoin('stores as s', 'i.store_id', 's.id')
    .select('i.*', 's.name as store_name')
    .where({ 'i.brand_id': brand_id }).whereRaw('i.stock <= i.threshold').orderByRaw('i.stock - i.threshold');
  if (sid) ingQ.where({ 'i.store_id': sid });
  const lowStock = await ingQ;

  const alertQ = knex('alert_log as a')
    .join('ingredients as i', 'a.ingredient_id', 'i.id')
    .select('a.*', 'i.name', 'i.unit')
    .where('a.brand_id', brand_id)
    .orderBy('a.sent_at', 'desc').limit(20);
  if (sid) alertQ.where('a.store_id', sid);
  const recentAlerts = await alertQ;

  const orderQ = knex('orders').where({ brand_id }).orderBy('processed_at', 'desc').limit(10);
  if (sid) orderQ.where({ store_id: sid });
  const recentOrders = await orderQ;

  // 리스크 알림 (OPEN) — 현재 선택된 가맹점 기준으로만 표시
  const riskQ = knex('risk_alerts as r')
    .leftJoin('stores as s', 'r.store_id', 's.id')
    .select('r.*', 's.name as store_name')
    .where({ 'r.brand_id': brand_id, 'r.status': RISK_STATUSES.OPEN })
    .orderBy('r.created_at', 'desc').limit(10);
  if (sid) riskQ.where('r.store_id', sid);
  const risks = await riskQ;

  // 발주 현황 — 나머지 카드는 이미 sid를 타는데 이 둘만 브랜드 전체라 가맹점 화면에서 숫자가 튀었다.
  const pendingOrdersQ = knex('purchase_orders').where({ brand_id, status: ORDER_STATUSES.ORDERED }).count('id as cnt').first();
  if (sid) pendingOrdersQ.where({ store_id: sid });
  const paymentPendingQ = knex('purchase_orders').where({ brand_id, status: ORDER_STATUSES.PAYMENT_PENDING }).count('id as cnt').first();
  if (sid) paymentPendingQ.where({ store_id: sid });
  const [pendingOrders, paymentPending] = await Promise.all([pendingOrdersQ, paymentPendingQ]);

  // 결제대기 방치 — 발주는 확정됐지만 가맹점이 결제를 안 해서 출고 자체가 묶여있는 건을 본사가
  // 알아서 찾아봐야 했던 문제 → 24시간 넘게 결제대기 상태인 건을 경고로 집계
  const overdueQ = knex('purchase_orders as po')
    .join('stores as s', 'po.store_id', 's.id')
    .select('po.id', 'po.store_id', 's.name as store_name', 'po.updated_at', 'po.total_amount', 'po.confirmed_amount')
    .where({ 'po.brand_id': brand_id, 'po.status': ORDER_STATUSES.PAYMENT_PENDING })
    .where('po.updated_at', '<', new Date(Date.now() - 24 * 3600000).toISOString())
    .orderBy('po.updated_at');
  if (sid) overdueQ.where('po.store_id', sid);
  const paymentOverdue = await overdueQ;

  // 일자별 매출/주문건수 집계 헬퍼 (특정 하루치)
  // 매출액/주문건수는 기존처럼 sales_items(메뉴별 판매)에서, 할인·순매출·NET매출·결제수단별 금액은
  // 주문 단위 chargePrice/payments를 정규화해 저장해둔 orders의 새 컬럼에서 집계 (결제완료 주문만)
  const dayStats = async (date) => {
    const { startIso: start, endIso: end } = kstDayRange(date);

    // 총매출액/주문건수도 orders 테이블(결제 데이터)에서 집계한다.
    // 과거엔 sales_items(메뉴별 라인아이템)에서 집계했는데, POS 설정에 따라 라인아이템 필드명이 달라
    // 파싱이 안 되는 주문이 있으면 결제는 정상 기록(orders)되고도 메뉴별 내역(sales_items)만 비어
    // "현금/카드 금액은 있는데 총매출액·건수는 0원"으로 보이는 불일치가 생겼음 — 결제 단위 집계로 통일해 해결
    const financeQ = knex('orders').where({ brand_id, order_state: 'COMPLETED' })
      .where('processed_at', '>=', start).where('processed_at', '<=', end);
    if (sid) financeQ.where({ store_id: sid });
    const [finance, cnt] = await Promise.all([
      financeQ.clone()
        .sum({ listPrice: 'list_price', discountAmount: 'discount_amount', totalAmount: 'total_amount', supplyAmount: 'supply_amount',
               cashAmount: 'cash_amount', cardAmount: 'card_amount', otherAmount: 'other_amount' }).first(),
      financeQ.clone().count('id as cnt').first(),
    ]);

    return {
      revenue: Number(finance?.listPrice || 0), orderCount: Number(cnt?.cnt || 0),
      discountAmount: Number(finance?.discountAmount || 0),
      netAmount: Number(finance?.totalAmount || 0),
      supplyAmount: Number(finance?.supplyAmount || 0),
      cashAmount: Number(finance?.cashAmount || 0),
      cardAmount: Number(finance?.cardAmount || 0),
      otherAmount: Number(finance?.otherAmount || 0),
    };
  };

  const yesterday = new Date(Date.now() - 86400000);
  const sameWeekdayLastWeek = new Date(Date.now() - 7 * 86400000);
  const [todayStats, yesterdayStats, lastWeekStats] = await Promise.all([
    dayStats(new Date()), dayStats(yesterday), dayStats(sameWeekdayLastWeek),
  ]);

  // 최근 7일 일별 매출 통계 — 하루씩 순차 조회하면 DB 왕복이 누적돼 대시보드 응답이
  // 몇 초씩 느려지므로(특히 이 데이터를 기다리는 재고/리스크 팝업까지 늦게 뜨는 원인이었음)
  // 7일치를 한꺼번에 병렬로 조회
  const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토'];
  const weekDates = Array.from({ length: 7 }, (_, idx) => new Date(Date.now() - (6 - idx) * 86400000));
  const weeklyStatsResults = await Promise.all(weekDates.map(d => dayStats(d)));
  const weeklyStats = weekDates.map((d, idx) => ({
    date: d.toISOString().split('T')[0], weekday: WEEKDAY_LABEL[d.getDay()], ...weeklyStatsResults[idx],
  }));

  // 재고 자산가치 — 현재 재고(가맹점) × 발주 단가로, 이 가맹점에 자금이 재고로 얼마나 묶여있는지 추정
  // (재료 단가는 그 재료에 연결된 발주상품의 price를 기본단위 기준으로 환산해서 사용)
  let stockValue = 0;
  if (sid) {
    const storeIngredients = await knex('ingredients').where({ brand_id, store_id: sid });
    const products = await knex('products').where({ brand_id, is_active: true });
    const baseIds = products.map(p => p.ingredient_id).filter(Boolean);
    const baseIngredients = baseIds.length ? await knex('ingredients').whereIn('id', baseIds) : [];
    const baseNameById = Object.fromEntries(baseIngredients.map(i => [i.id, i.name]));
    const unitCostByName = {};
    for (const p of products) {
      const name = p.ingredient_id ? baseNameById[p.ingredient_id] : p.name;
      if (!name) continue;
      unitCostByName[name] = (p.price || 0) / (p.unit_conversion || 1);
    }
    stockValue = Math.round(storeIngredients.reduce((sum, ing) => sum + (ing.stock || 0) * (unitCostByName[ing.name] || 0), 0));
  }

  res.json({
    lowStock, recentAlerts, recentOrders, risks, stockValue, paymentOverdue,
    pendingOrders: pendingOrders.cnt, paymentPending: paymentPending.cnt, todayRevenue: todayStats.revenue,
    salesComparison: { today: todayStats, yesterday: yesterdayStats, lastWeekSameDay: lastWeekStats },
    weeklyStats,
  });
});

// 재료별 폐기량 집계 — "예상 소진량"에 판매분뿐 아니라 폐기분도 포함시키기 위해 쓰인다.
// 실제로 가게가 사야 하는 양은 "판매로 쓴 양 + 버린 양(+ 재고 증가분)"인데, 지금까지는 판매분만
// 봐서 폐기가 많은 정상 가맹점이 발주 대비 과소소진으로 보여 억울하게 "과다 발주"로 잡히거나,
// 반대로 폐기 때문에 정상적인 발주부족이 "사입 의심"으로 오탐될 수 있었다.
// waste_logs.waste_date는 date 컬럼(시간 정보 없음)이라 ISO 문자열의 날짜 부분만 잘라 비교한다
// (server/src/routes/risks.js의 checkHighWaste와 동일한 방식).
// 재고 증가분(기초/기말 재고 차이)은 stock_ledger로 계산 가능하지만 기초 재고를 정확히 구하려면
// 조회 기간 이전 전체 이력을 훑어야 해서 비용이 크고, 이 화면의 목적(사입 의심 감지)에서는
// "당장 소진되지 않고 창고에 쌓인 재고"까지 매번 정밀 계산할 필요는 적다고 판단해 이번엔 넣지
// 않았다 — 남는 오차: 가맹점이 실제로 재고를 늘리는(비축) 정상적인 발주를 했을 경우 ratio가
// 낮게(과소발주로) 잘못 나올 수 있다.
async function getWasteByIngredient(brand_id, store_id, fromISO, toISO) {
  const q = knex('waste_logs')
    .where({ brand_id })
    .where('waste_date', '>=', fromISO.slice(0, 10))
    .where('waste_date', '<=', toISO.slice(0, 10))
    .select('ingredient_name', 'unit', knex.raw('SUM(quantity) as total_waste'))
    .groupBy('ingredient_name', 'unit');
  if (store_id) q.where({ store_id });
  return q;
}

// 판매 기준 예상 소진량(consumptionEntries)에 같은 기간 폐기량을 더한다. 단위가 다른 폐기
// 기록(재료 기본단위가 바뀐 이력, 자유입력 등)을 그냥 더하면 값이 틀어지므로 이름+단위가 정확히
// 일치할 때만 합산하고, 다르면 무시한다 — 그 경우 예상 소진량이 과소평가될 수 있다(알려진 오차).
// 기존 estimated 필드는 유지하되 값을 "판매+폐기" 합계로 바꾸고(발주 비교 기준이 이거여야 정확함),
// 판매분만 따로도 볼 수 있게 sales_estimated/waste를 추가 필드로 함께 내려준다.
function withWaste(consumptionEntries, wasteRows) {
  return consumptionEntries.map(c => {
    const wasteRow = wasteRows.find(w => w.ingredient_name === c.name && w.unit === c.unit);
    const waste = wasteRow ? Number(wasteRow.total_waste) : 0;
    return { ...c, sales_estimated: c.estimated, waste, estimated: c.estimated + waste };
  });
}

// 기간 동안의 순수 재고 증감(기말재고 − 기초재고)을 stock_ledger에서 구한다. 위 withWaste 주석에
// 남아있던 "기초 재고를 정확히 구하려면 조회 기간 이전 전체 이력을 훑어야 해서 비용이 크다"는
// 판단은, 절대값(기초/기말 재고 그 자체)을 재구성하려 할 때만 맞는 얘기다 — 우리에게 필요한 건
// 절대값이 아니라 "그 사이에 얼마나 늘거나 줄었는지"뿐이고, 이는 재고 컬럼이 매 변동(delta)의
// 누적이라는 성질(텔레스코핑 합) 덕에 기간 내 quantity_delta를 그냥 더하기만 해도 정확히
// "기말-기초"와 같다. 즉 이력 전체를 훑을 필요 없이 기간 내 행만 SUM하면 된다.
//
// 판매(SALE)/폐기(WASTE) 델타도 이 합계에 포함시킨다 — 얼핏 이상해 보이지만(판매/폐기는 이미
// sales_estimated·waste로 따로 더하고 있으니까), 이건 이중 계산이 아니라 정확히 그 반대다.
// "사야 할 양 = 판매 + 폐기 + (기말-기초)"라는 항등식 자체가 "기말-기초는 판매·폐기로 줄고
// 입고/조정으로 늘어난 순증감"이라는 전제 위에 서 있어서, (기말-기초)에 판매·폐기 델타가 이미
// 빠져있다면(=제외한다면) 오히려 그만큼 다시 빼는 꼴이 되어 항등식이 깨진다. 실사조정
// (ADJUSTMENT)도 포함한다 — 실사 차이가 "미기록 소모"든 "장부 오류"든, 물리적 재고 자체는 이미
// 그만큼 바뀌어 있고 우리가 맞추려는 건 바로 그 물리적 재고이므로 빼면 안 된다. 어떤 타입이든
// 하나라도 빠지면 "기말-기초" 항등식이 그 기간에만 체계적으로 틀어져, 실사가 낀 기간(가맹점당
// 주기적으로 발생 — CLAUDE.md의 "30일 재고실사" 참고)마다 보정값이 어긋나는 편이 하나 없는
// 것보다 나쁘다.
//
// 커버리지 판단: stock_ledger 기록이 이 재료에 한해 fromISO 이전부터 이미 시작돼 있었는지를
// "가장 오래된 기록 시각"으로 확인한다. 이 기능은 최근에 도입돼 과거 데이터가 없는 재료가 있을
// 수 있는데, 그 경우 기간 내 SUM은 "추적 시작 전에 일어난 변동"을 놓쳐 실제보다 작게(또는
// 0으로) 잡힌다. 그런 재료는 차라리 "모른다"고 표시하고 보정을 적용하지 않는 편이, 틀린 값을
// 맞는 값인 척 내보내는 것보다 낫다(CLAUDE.md 지시 — "틀린 보정은 안 하느니만 못하다").
// 단, 그 재료 자체가 fromISO 이후에 생성됐다면("놓칠 이전 이력"이 원천적으로 없는 경우 — 예:
// 조회 기간 도중 새로 등록된 재료) 첫 ledger 기록이 fromISO보다 늦어도 커버리지가 있다고 본다.
// createdAtById로 재료 생성 시각을 받는다 — 호출부가 이미 다른 목적으로 ingredients 행을 통째로
// 조회해둔 게 있어(getIngredientComparison의 `ingredients`, /analytics의 `ingredientRows`) 여기서
// 다시 조회하지 않고 그 결과를 재사용한다(추가 쿼리 없음).
//
// (과거의 알려진 한계였던) PUT /ingredients/:id(직접 재고 수정)와 POST /ingredients/:id/restock
// (간편 입고)의 stock_ledger 미기록은 해소됐다 — 이제 두 라우트 모두 재고 변경과 같은 트랜잭션
// 안에서 logStockMovement를 호출한다(각 라우트 정의부의 주석 참고). 그 경로로만 재고가 바뀐
// 기간도 이제 이 SUM(quantity_delta)에 정상적으로 잡힌다.
//
// ingredientIds 개수와 무관하게 항상 쿼리 2번(기간 내 합계, 최초 기록 시각)으로 끝난다 —
// 재료마다 왕복하지 않는다(호출부 — /purchase-anomalies가 가맹점마다 이 함수를 호출하는
// getIngredientComparison을 통해 부르므로, 재료 수가 아니라 가맹점 수에만 비례해야 한다).
async function getStockChangeByIngredient(brand_id, store_id, fromISO, toISO, ingredientIds, createdAtById) {
  const result = new Map();
  if (!ingredientIds || ingredientIds.length === 0) return result;
  const scoped = () => {
    const q = knex('stock_ledger').where({ brand_id }).whereIn('ingredient_id', ingredientIds);
    if (store_id) q.where({ store_id });
    return q;
  };
  const [deltaRows, firstRows] = await Promise.all([
    // stock_ledger.created_at은 knex.fn.now() 기본값이라 ISO 문자열과 그대로 비교하면 방언별로 갈라진다.
    scoped().where('created_at', '>=', toDbTime(fromISO)).where('created_at', '<=', toDbTime(toISO))
      .select('ingredient_id', knex.raw('SUM(quantity_delta) as change')).groupBy('ingredient_id'),
    scoped().select('ingredient_id', knex.raw('MIN(created_at) as first_at')).groupBy('ingredient_id'),
  ]);
  const changeById = new Map(deltaRows.map(r => [r.ingredient_id, Number(r.change) || 0]));
  const firstAtById = new Map(firstRows.map(r => [r.ingredient_id, r.first_at]));
  const fromTime = new Date(fromISO).getTime();
  for (const id of ingredientIds) {
    const firstAt = firstAtById.get(id);
    // fromISO와 같은 시각도 "이전부터 있었다"로 간주 — DB 타임스탬프 정밀도(초 단위)상 완전히
    // 동시일 때 부당하게 커버리지를 거부하지 않기 위함이며, 어차피 그 한 행이 SUM에도 포함되므로
    // 결과가 어긋나지 않는다.
    const trackedBeforePeriod = !!firstAt && new Date(firstAt).getTime() <= fromTime;
    const createdAt = createdAtById && createdAtById.get(id);
    const createdWithinPeriod = !!createdAt && new Date(createdAt).getTime() >= fromTime;
    const known = trackedBeforePeriod || createdWithinPeriod;
    result.set(id, { change: known ? (changeById.get(id) || 0) : null, known });
  }
  return result;
}

// ─── 판매 분석 ────────────────────────────────────────
router.get('/analytics', requireAuth, async (req, res) => {
  const { store_id, from, to } = req.query;
  const isStoreRole = ['STORE_OWNER', 'STORE_STAFF'].includes(req.user.role);
  if (isStoreRole && !req.user.store_id) return res.status(400).json({ error: '소속 가맹점 정보가 없습니다. 관리자에게 문의해주세요' });
  const sid = isStoreRole ? req.user.store_id : (store_id ? Number(store_id) : req.user.store_id);
  const brand_id = req.user.brand_id;

  const toISO = parseDateParam(to, new Date());
  const fromISO = parseDateParam(from, Date.now() - 30 * 86400000);
  if (!toISO || !fromISO) return res.status(400).json({ error: DATE_PARAM_ERROR });
  const toDate = new Date(toISO);
  const fromDate = new Date(fromISO);

  // sales_items에서 메뉴별 판매량 집계
  const salesQ = knex('sales_items')
    .where({ brand_id })
    .where('sold_at', '>=', fromISO)
    .where('sold_at', '<=', toISO)
    .select('menu_name', 'toss_menu_id',
      knex.raw('SUM(quantity) as total_qty'),
      knex.raw('SUM(amount) as total_amount'),
      knex.raw('COUNT(DISTINCT toss_order_id) as order_count')
    )
    .groupBy('menu_name', 'toss_menu_id')
    .orderBy('total_qty', 'desc');
  if (sid) salesQ.where({ store_id: sid });
  const salesRows = await salesQ;

  // 매장별 일별 매출 (차트용). sales_items.sold_at은 pg에서 timestamptz(knex t.datetime의 기본),
  // sqlite에서는 앱이 넣은 ISO 문자열이다. 예전엔 둘 다 UTC 날짜로 잘라서, TZ=Asia/Seoul을 넣어
  // JS 쪽 "오늘"만 KST가 된 뒤로 같은 화면 안에서 일별 차트와 my-tasks의 "오늘"이 어긋났다.
  const dateExpr = isProduction
    ? "to_char(sold_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD')"
    : "strftime('%Y-%m-%d', datetime(sold_at, '+9 hours'))";
  const dailyQ = knex('sales_items')
    .where({ brand_id })
    .where('sold_at', '>=', fromISO)
    .where('sold_at', '<=', toISO)
    .select(
      knex.raw(`${dateExpr} as date`),
      'store_id',
      knex.raw('SUM(amount) as revenue'),
      knex.raw('SUM(quantity) as qty')
    )
    .groupByRaw(`${dateExpr}, store_id`)
    .orderBy('date');
  if (sid) dailyQ.where({ store_id: sid });
  const dailyRows = await dailyQ;

  // 메뉴 매칭 (레시피 연결용) — webhook.js의 adjustStock/getIngredientComparison과 같은 우선순위
  // (ID 우선, 이름은 폴백)로 맞춘다. 여기서 우선순위가 어긋나면 이름을 바꿔 파는 메뉴가 재고
  // 차감(웹훅)에서는 정상 매칭되는데 이 화면에서는 다른 메뉴로 잘못 매칭되는 어긋남이 생긴다.
  const menus = await knex('menus').where({ brand_id }).select('id', 'name', 'toss_menu_id', 'is_key', 'recipe_source_menu_id');
  const menuIndex = buildMenuIndex(menus);
  const sales = salesRows.map(s => ({
    menu: matchMenu(menuIndex, s.toss_menu_id, s.menu_name),
    quantity: Number(s.total_qty),
  }));

  // 식자재별 예상 소진량(리스크 알림의 근거값) — 표준메뉴 연결/세트 구성까지 포함해 계산하는
  // menuResolver.resolveConsumptionBulk 하나로 통일한다(getIngredientComparison과 동일 로직).
  // 세트로만 파는 메뉴가 여기서 빠지면 그 메뉴는 재료를 하나도 사입 안 해도 알림이 안 뜬다.
  const consumptionMapByIngredientId = await resolveConsumptionBulk(knex, sales);

  // salesByMenu[].ingredients(메뉴별 재료 내역)도 같은 계산(세트/표준연결 반영)이어야 화면과
  // 알림의 근거가 어긋나지 않는다. 다만 이 화면은 자주 열리므로 판매 종류(distinct 메뉴)마다
  // resolveConsumption을 실제 쿼리로 호출할 수는 없다 — resolveConsumptionBulk가 하듯,
  // recipe_source_menu_id/menu_components가 가리킬 수 있는 메뉴는 전부 이 브랜드의 menus
  // 안에 있으므로 recipes/menu_components를 이 브랜드 메뉴 id 전체 기준으로 딱 한 번씩만 미리
  // 읽어 메모리에 올려두고, 그 위에서 resolveConsumption을 메뉴 수만큼 호출한다(진짜 DB 왕복
  // 없이 knex와 같은 인터페이스(table(...).whereIn(...).select(...))를 흉내내는 메모리 전용
  // queryable을 넘긴다) — 계산 로직 자체는 여전히 menuResolver.js 하나만 쓴다.
  const brandMenuIds = menus.map(m => m.id);
  const allRecipeRows = brandMenuIds.length
    ? await knex('recipes').whereIn('menu_id', brandMenuIds).select('menu_id', 'ingredient_id', 'amount')
    : [];
  const allComponentRows = brandMenuIds.length
    ? await knex('menu_components').whereIn('set_menu_id', brandMenuIds).select('set_menu_id', 'component_menu_id', 'quantity')
    : [];
  const menuRowById = new Map(menus.map(m => [m.id, m]));
  function memoryGraphQueryable(table) {
    return {
      whereIn(col, ids) {
        const idSet = new Set(ids);
        let rows = [];
        if (table === 'recipes') rows = allRecipeRows.filter(r => idSet.has(r.menu_id));
        else if (table === 'menu_components') rows = allComponentRows.filter(r => idSet.has(r.set_menu_id));
        else if (table === 'menus') rows = ids.map(id => menuRowById.get(id)).filter(Boolean);
        return { select: () => Promise.resolve(rows) };
      },
    };
  }
  const consumptionByMenuIndex = await Promise.all(
    sales.map(s => (s.menu ? resolveConsumption(memoryGraphQueryable, s.menu, s.quantity) : []))
  );

  // 소모량에 등장하는 재료 id 전부(메뉴별 내역 + 합계) 이름/단위를 한 번에 조회 — 재료가 이미
  // 삭제됐는데 레시피/판매 기록만 남아있는 경우도 조용히 빠뜨리지 않는다(getIngredientComparison과
  // 동일한 처리 — 조용히 사라지면 그 재료만 사입 감시에서 빠지는 새 구멍이 된다).
  const allIngredientIds = new Set(consumptionMapByIngredientId.keys());
  for (const rows of consumptionByMenuIndex) for (const r of rows) allIngredientIds.add(r.ingredient_id);
  const ingredientRows = allIngredientIds.size ? await knex('ingredients').whereIn('id', [...allIngredientIds]) : [];
  const ingredientById = new Map(ingredientRows.map(i => [i.id, i]));
  const ingNameUnit = (id) => {
    const ing = ingredientById.get(id);
    return ing ? { name: ing.name, unit: ing.unit } : { name: `(삭제된 재료 #${id})`, unit: '' };
  };

  const salesByMenu = salesRows.map((s, idx) => {
    const menu = sales[idx].menu;
    const soldQty = Number(s.total_qty);
    return {
      menu_id: menu?.id || null,
      menu_name: s.menu_name,
      is_key: menu?.is_key || false,
      sold_qty: soldQty,
      total_amount: Number(s.total_amount),
      order_count: Number(s.order_count),
      ingredients: consumptionByMenuIndex[idx].map(r => ({ ...ingNameUnit(r.ingredient_id), estimated_usage: r.amount })),
    };
  });

  // 식자재별 예상 소진량 — 위 resolveConsumptionBulk 결과(ingredient_id 기준)를 기존 응답 형태
  // (이름 키)로 변환한다.
  // 재고 이월 보정(기간 내 순증감)도 같은 ingredient_id 기준으로 한 번에 조회해 합쳐 넣는다 —
  // 이름 키로 변환하기 *전에* 붙여야, 같은 이름을 쓰는 여러 매장의 재료(브랜드 전체 조회, sid
  // 없음)가 하나의 이름 키로 뭉쳐질 때 그 증감분도 같이 합산된다.
  const createdAtById = new Map(ingredientRows.map(i => [i.id, i.created_at]));
  const stockChangeByIngredientId = await getStockChangeByIngredient(
    brand_id, sid, fromISO, toISO, [...consumptionMapByIngredientId.keys()], createdAtById
  );
  const consumptionMap = {};
  for (const [ingredientId, amount] of consumptionMapByIngredientId) {
    const { name, unit } = ingNameUnit(ingredientId);
    const sc = stockChangeByIngredientId.get(ingredientId) || { change: null, known: false };
    const prev = consumptionMap[name];
    if (prev) {
      // 이름이 같은 재료가 여러 매장에 걸쳐 있을 수 있다(sid 없이 브랜드 전체를 볼 때). estimated는
      // 기존 코드가 그대로 마지막 값으로 덮어쓰던 부분이라(이 작업 범위인 소모량 계산이 아니라
      // 손대지 않음) 그대로 두지만, 새로 추가하는 재고증감은 그 이름의 모든 재료에 걸친 실제
      // 물리적 증감 총합이어야 뜻이 맞으므로 합산한다. 하나라도 커버리지를 모르면 전체를 "모름"
      // 으로 본다 — 일부만 아는 상태로 합친 값이 마치 전체를 아는 것처럼 보이는 게 더 위험하다.
      consumptionMap[name] = {
        name, unit, estimated: amount,
        stock_change: (prev.stock_change_known && sc.known) ? prev.stock_change + sc.change : null,
        stock_change_known: prev.stock_change_known && sc.known,
      };
    } else {
      consumptionMap[name] = { name, unit, estimated: amount, stock_change: sc.known ? sc.change : null, stock_change_known: sc.known };
    }
  }

  // 발주량 집계
  const orderedItemsQ = knex('purchase_order_items as poi')
    .join('purchase_orders as po', 'poi.order_id', 'po.id')
    .join('products as p', 'poi.product_id', 'p.id')
    .leftJoin('ingredients as i', 'p.ingredient_id', 'i.id')
    .where('po.brand_id', brand_id)
    .whereNotIn('po.status', [ORDER_STATUSES.DRAFT, ORDER_STATUSES.CANCELED])
    // purchase_orders.created_at도 knex.fn.now() 기본값(sqlite는 UTC 문자열)이라 ISO와 그대로
    // 비교하면 방언별로 어긋난다 — 1103행과 동일한 이유로 toDbTime을 거친다.
    .where('po.created_at', '>=', toDbTime(fromISO))
    .where('po.created_at', '<=', toDbTime(toISO))
    .select('i.name as ing_name', 'i.unit as ing_unit', knex.raw('SUM(poi.quantity * p.unit_conversion) as total_ordered'))
    .groupBy('i.id');
  if (sid) orderedItemsQ.where('po.store_id', sid);
  const orderedItems = await orderedItemsQ;

  const wasteRows = await getWasteByIngredient(brand_id, sid, fromISO, toISO);
  const comparison = withWaste(Object.values(consumptionMap), wasteRows).map(c => {
    const ordered = orderedItems.find(o => o.ing_name === c.name);
    const totalOrdered = ordered ? Number(ordered.total_ordered) : 0;
    // 재고 이월 보정 — 커버리지를 아는 재료만 (판매+폐기)에 기간 내 재고 순증감을 더해 "사야 할
    // 양"을 구한다. 모르면(stock_change_known=false) 기존 그대로 판매+폐기만으로 비교한다 —
    // getStockChangeByIngredient 주석 참고.
    const required = c.stock_change_known ? c.estimated + c.stock_change : c.estimated;
    const ratio = required > 0 ? Math.round((totalOrdered / required) * 100) / 100 : null;
    return { ...c, total_ordered: totalOrdered, required_purchase: required, ratio };
  });

  // 과다 사입 / 발주 부족(사입 의심) 리스크 자동 생성 — 본사가 설정한 배수 기준
  if (sid) {
    const { createRisk, getRiskSettings } = require('./risks');
    const settings = await getRiskSettings(brand_id);
    // 발주 부족(사입 의심) 판정 기준. overPurchaseRatio처럼 브랜드별로 설정 가능해야 자연스럽지만
    // getRiskSettings/DEFAULT_RISK_SETTINGS(server/src/routes/risks.js)가 이번 작업 범위 밖이라
    // 손대지 못했다 — /purchase-anomalies와 같은 상수(constants.js의 PURCHASE_RATIOS)를 쓴다.
    // TODO: risks.js의 DEFAULT_RISK_SETTINGS에 underPurchaseRatio를 추가하고 여기서 참조하도록 교체할 것.
    const UNDER_PURCHASE_RATIO = PURCHASE_RATIOS.UNDER;
    for (const c of comparison) {
      // 재고 이월 보정이 적용됐으면(stock_change_known) 알림 문구도 실제 판정 기준(required_purchase)을
      // 보여준다 — ratio가 estimated(판매+폐기)만으로 나눈 값이 아니게 됐는데 문구는 여전히 estimated
      // 대비라고 적으면, 운영자가 직접 나눗셈을 해보고 숫자가 안 맞는다며 알림 자체를 못 믿게 된다.
      const basisNote = c.stock_change_known
        ? ` [재고증감 ${c.stock_change >= 0 ? '+' : ''}${Math.round(c.stock_change)}${c.unit} 반영, 필요량 ${Math.round(c.required_purchase)}${c.unit}]`
        : ' [재고 이월 이력 부족으로 미보정]';
      if (c.ratio !== null && c.ratio > settings.overPurchaseRatio && c.estimated > 0) {
        createRisk(brand_id, sid, RISK_TYPES.OVER_PURCHASE, RISK_SEVERITIES.MEDIUM,
          `과다 사입 가능성: ${c.name} — 예상 소진 ${Math.round(c.estimated)}${c.unit} 대비 발주 ${Math.round(c.total_ordered)}${c.unit} (${c.ratio}배)${basisNote}`,
          { ingredient: c.name, estimated: c.estimated, ordered: c.total_ordered, waste: c.waste,
            stock_change: c.stock_change, stock_change_known: c.stock_change_known, required_purchase: c.required_purchase }
        ).catch(() => {});
      }
      // RISK_TYPES에 아직 이 항목에 대응하는 타입이 없다(constants.js는 이번 작업에서 수정 금지 범위).
      // 우선 문자열 리터럴로 만들어 기존 체계(risk_alerts.type은 자유 문자열 컬럼)에 얹고,
      // 임계값은 아직 상수 — risks.js의 DEFAULT_RISK_SETTINGS에 underPurchaseRatio로 빼는 게 맞다.
      if (c.ratio !== null && c.ratio < UNDER_PURCHASE_RATIO && c.estimated > 0) {
        // 심각도는 과다발주(MEDIUM)보다 높은 HIGH로 둔다 — 과다발주는 자금이 재고에 묶이는
        // 비효율 문제인 반면, 발주 부족은 이 기능의 존재 이유인 "본사 대신 다른 곳에서 사입"
        // 가능성을 가리키는 신호라 매출 유출·품질관리 이탈로 이어질 수 있어 더 중대하다.
        // description은 "사입했다"고 단정하지 않는다 — 레시피 수량 오류나 재고를 미리 채워둔
        // 경우(비축)에도 같은 숫자가 나올 수 있어, 사실(수치)만 적고 판단은 운영자 몫으로 남긴다.
        createRisk(brand_id, sid, RISK_TYPES.UNDER_PURCHASE, RISK_SEVERITIES.HIGH,
          `발주 부족 의심: ${c.name} — 예상 소진 ${Math.round(c.estimated)}${c.unit}(폐기 ${Math.round(c.waste)}${c.unit} 포함) 대비 발주 ${Math.round(c.total_ordered)}${c.unit} (${c.ratio}배)${basisNote}. 사입 여부는 확인이 필요하며 레시피 오차·재고 비축 등 다른 원인일 수도 있음`,
          { ingredient: c.name, estimated: c.estimated, ordered: c.total_ordered, waste: c.waste,
            stock_change: c.stock_change, stock_change_known: c.stock_change_known, required_purchase: c.required_purchase }
        ).catch(() => {});
      }
    }
  }

  res.json({ salesByMenu, dailyRevenue: dailyRows, comparison, period: { from: fromISO, to: toISO } });
});

// 가맹점 하나의 식자재별 "예상 소진 vs 실제 발주" 비교 (사입 이상 감지용, /purchase-anomalies·
// /products의 발주추천이 사용).
//
// 소모량 계산은 menuResolver.resolveConsumptionBulk 하나로 통일한다. 예전엔 여기서 recipes를 직접
// 순회했는데, 그러면 표준 메뉴 연결(recipe_source_menu_id)이나 세트 구성(menu_components)으로 파는
// 메뉴는 그 메뉴 자신에게 레시피가 없어 소모량이 통째로 0으로 계산됐다 — "세트로 100그릇을 팔아도
// 예상 소진량 0"이라 재료를 하나도 사입 안 해도 사입 감시를 그대로 피해가는 구멍이었다. 웹훅의
// 실제 재고 차감(webhook.js의 adjustStock)과 반드시 같은 계산을 써야 이 구멍이 다시 생기지 않는다
// (menuResolver.js 상단 주석 참고).
//
// productCache: { products, brandIngredients } — 호출부가 가맹점 여러 곳을 순회하며 이 함수를
// 반복 호출할 때(/purchase-anomalies), 가맹점에 따라 달라지지 않는 브랜드 전체 상품/재료 목록을
// 미리 한 번만 조회해 넘기면 가맹점 수만큼 반복 조회하지 않아도 된다. 넘기지 않으면(단일 가맹점만
// 보는 /products의 발주추천 등) 이 함수 안에서 직접 조회한다.
async function getIngredientComparison(brand_id, store_id, fromISO, toISO, productCache) {
  const salesQ = knex('sales_items')
    .where({ brand_id, store_id })
    .where('sold_at', '>=', fromISO).where('sold_at', '<=', toISO)
    .select('menu_name', 'toss_menu_id', knex.raw('SUM(quantity) as total_qty'))
    .groupBy('menu_name', 'toss_menu_id');
  const salesRows = await salesQ;

  const menus = await knex('menus').where({ brand_id, store_id });
  const menuIndex = buildMenuIndex(menus);
  const sales = salesRows.map(row => ({
    menu: matchMenu(menuIndex, row.toss_menu_id, row.menu_name),
    quantity: Number(row.total_qty),
  }));

  // 표준메뉴 연결/세트 구성까지 포함한 실제 재료 소모량 — Map<ingredient_id, amount>. 판매 종류
  // (서로 다른 메뉴)마다 쿼리를 날리지 않는다 — resolveConsumptionBulk 내부에서 관련 메뉴들의
  // recipes/menu_components/menus를 whereIn으로 한 번에 모은다(menuResolver.js 참고).
  const consumptionMap = await resolveConsumptionBulk(knex, sales);

  const ingredientIds = [...consumptionMap.keys()];
  const ingredients = ingredientIds.length ? await knex('ingredients').whereIn('id', ingredientIds) : [];
  const ingredientById = new Map(ingredients.map(i => [i.id, i]));
  // 재료가 이미 삭제됐는데 레시피/판매 기록만 남아있는 경우도 조용히 빠뜨리지 않고 계속 노출한다 —
  // 조용히 사라지면 그 재료만 사입 감시에서 빠지는 새 구멍이 된다.
  const consumptionEntries = ingredientIds.map(id => {
    const ing = ingredientById.get(id);
    return { ingredient_id: id, name: ing ? ing.name : `(삭제된 재료 #${id})`, unit: ing ? ing.unit : '', estimated: consumptionMap.get(id) };
  });

  // 발주량 집계 — ingredient_id 기준으로 맞춘다. products.ingredient_id가 비어있는 상품(재료를
  // 발주단위 그대로 파는 상품 — 대시보드 재고자산가치/발주추천이 이미 "상품명 = 재료명"으로 취급
  // 하는 관례, 아래 products.js의 baseNameById 패턴 참고)은 이름으로 실제 재료를 찾아 id를 역으로
  // 채운다. 예전 코드는 여기서 곧장 ingredients.id로 그룹핑했는데, ingredient_id가 비어있는 상품은
  // LEFT JOIN 결과 전부 NULL 하나로 뭉쳐 어떤 재료와도 매칭되지 않았다 — 그 결과 그런 상품으로
  // 정상 발주해도 "발주 0"으로 보여 사입 의심으로 오탐되는 구멍이 있었다.
  const products = productCache?.products || await knex('products').where({ brand_id });
  const brandIngredients = productCache?.brandIngredients || await knex('ingredients').where({ brand_id });
  const ingredientIdByName = new Map();
  for (const i of brandIngredients) {
    if (i.store_id !== store_id && i.store_id !== null) continue; // 이 가맹점 전용이거나 브랜드 공통인 재료만 후보
    if (i.store_id === store_id || !ingredientIdByName.has(i.name)) ingredientIdByName.set(i.name, i.id);
  }
  const productIngredientId = new Map();
  for (const p of products) {
    if (p.ingredient_id) { productIngredientId.set(p.id, p.ingredient_id); continue; }
    const resolved = ingredientIdByName.get(p.name);
    if (resolved) productIngredientId.set(p.id, resolved);
  }

  const orderedRows = await knex('purchase_order_items as poi')
    .join('purchase_orders as po', 'poi.order_id', 'po.id')
    .join('products as p', 'poi.product_id', 'p.id')
    .where('po.brand_id', brand_id).where('po.store_id', store_id)
    .whereNotIn('po.status', [ORDER_STATUSES.DRAFT, ORDER_STATUSES.CANCELED])
    .where('po.created_at', '>=', toDbTime(fromISO)).where('po.created_at', '<=', toDbTime(toISO))
    .select('poi.product_id', knex.raw('SUM(poi.quantity * p.unit_conversion) as total_ordered'))
    .groupBy('poi.product_id');

  const orderedByIngredientId = new Map();
  for (const r of orderedRows) {
    const ingId = productIngredientId.get(r.product_id);
    if (!ingId) continue; // 어떤 재료에도 대응되지 않는 상품(이름이 어떤 재료와도 안 맞음) — 예전에도 동일하게 집계 제외됨
    orderedByIngredientId.set(ingId, (orderedByIngredientId.get(ingId) || 0) + Number(r.total_ordered));
  }

  const wasteRows = await getWasteByIngredient(brand_id, store_id, fromISO, toISO);
  // 재고 이월 보정 — 재료마다 쿼리를 날리지 않고 이 가맹점에 등장하는 ingredient_id 전체를
  // 한 번에 조회한다(getStockChangeByIngredient는 언제나 쿼리 2번, ingredientIds 개수와 무관).
  // 이 함수 자체가 /purchase-anomalies에서 가맹점마다 반복 호출되므로, 여기서 늘어나는 쿼리
  // 수는 가맹점 수에만 비례하고 재료 수에는 비례하지 않는다.
  const ingredientCreatedAtById = new Map(ingredients.map(i => [i.id, i.created_at]));
  const stockChangeMap = await getStockChangeByIngredient(brand_id, store_id, fromISO, toISO, ingredientIds, ingredientCreatedAtById);
  return withWaste(consumptionEntries, wasteRows).map(c => {
    const totalOrdered = orderedByIngredientId.get(c.ingredient_id) || 0;
    const sc = stockChangeMap.get(c.ingredient_id) || { change: null, known: false };
    // 커버리지를 모르면(sc.known=false) 보정 없이 기존 그대로(판매+폐기)만으로 비교한다 —
    // getStockChangeByIngredient 상단 주석 참고("틀린 보정은 안 하느니만 못하다").
    const required = sc.known ? c.estimated + sc.change : c.estimated;
    const ratio = required > 0 ? Math.round((totalOrdered / required) * 100) / 100 : null;
    return {
      ...c, total_ordered: totalOrdered,
      stock_change: sc.change, stock_change_known: sc.known, required_purchase: required,
      ratio,
    };
  });
}

// ─── 가맹점별 사입 이상 모니터링 ────────────────────────
router.get('/purchase-anomalies', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const { from, to } = req.query;
  const brand_id = req.user.brand_id;
  const toISO = parseDateParam(to, new Date());
  const fromISO = parseDateParam(from, Date.now() - 30 * 86400000);
  if (!toISO || !fromISO) return res.status(400).json({ error: DATE_PARAM_ERROR });
  const OVER_RATIO = PURCHASE_RATIOS.OVER, UNDER_RATIO = PURCHASE_RATIOS.UNDER;

  const stores = await knex('stores').where({ brand_id }).select('id', 'name');

  // 리스크 알림 발생 건수 — 과다발주(OVER_PURCHASE)뿐 아니라 발주부족(사입 의심,
  // (사입 의심, /analytics에서 생성) 알림도
  // 이 화면의 "리스크 알림 발생" 열이 반영해야 실제로 등록된 사입 의심 알림이 누락되지 않는다.
  const riskCounts = await knex('risk_alerts')
    .where({ brand_id }).whereIn('type', [RISK_TYPES.OVER_PURCHASE, RISK_TYPES.UNDER_PURCHASE])
    .where('created_at', '>=', toDbTime(fromISO)).where('created_at', '<=', toDbTime(toISO))
    .select('store_id', knex.raw('COUNT(*) as cnt'))
    .groupBy('store_id');

  // getIngredientComparison을 가맹점마다 반복 호출하는 루프다 — 가맹점에 따라 달라지지 않는
  // 브랜드 전체 상품/재료 목록은 여기서 한 번만 조회해 넘긴다(가맹점 수만큼 반복 조회 방지).
  const productCache = {
    products: await knex('products').where({ brand_id }),
    brandIngredients: await knex('ingredients').where({ brand_id }),
  };

  // 가맹점마다 순차(for await)로 돌면 가맹점 수만큼 DB 왕복이 직렬로 누적된다. sqlite는 커넥션이
  // 1개뿐이라 어차피 직렬화되지만, pg(운영)에서는 병렬화가 의미 있다 — 다만 한꺼번에 전부 날리면
  // 가맹점 수가 많을 때 커넥션 풀을 고갈시킬 수 있어 동시 5개 청크로 나눈다. 5는 pg 커넥션 풀
  // 기본값(10)의 절반 — 이 요청 하나가 풀 전체를 독점해 다른 요청이 커넥션을 못 잡는 상황을 피한다.
  const CHUNK_SIZE = 5;
  const comparisons = [];
  for (let i = 0; i < stores.length; i += CHUNK_SIZE) {
    const chunk = stores.slice(i, i + CHUNK_SIZE);
    const chunkResults = await Promise.all(chunk.map(s => getIngredientComparison(brand_id, s.id, fromISO, toISO, productCache)));
    comparisons.push(...chunkResults);
  }

  const result = stores.map((s, idx) => {
    const comparison = comparisons[idx];
    const overItems = comparison.filter(c => c.ratio !== null && c.ratio > OVER_RATIO);
    const underItems = comparison.filter(c => c.ratio !== null && c.ratio < UNDER_RATIO);
    const riskRow = riskCounts.find(r => r.store_id === s.id);
    return {
      store_id: s.id, store_name: s.name,
      over_count: overItems.length, under_count: underItems.length,
      worst_over: overItems.sort((a, b) => b.ratio - a.ratio)[0] || null,
      // worst_over와 대칭 — ratio가 가장 낮은(=발주가 예상 소진량 대비 가장 부족한, 사입 의심이
      // 가장 짙은) 항목. 지금까지는 under_count(개수)만 내려가고 어떤 재료인지는 이 화면을 클릭해
      // 들어가야만 알 수 있었다.
      worst_under: underItems.sort((a, b) => a.ratio - b.ratio)[0] || null,
      risk_alert_count: riskRow ? Number(riskRow.cnt) : 0,
    };
  });
  // 이 화면의 존재 이유는 "본사 대신 다른 데서 사입하는지" 감시하는 것이라 under_count(발주부족
  // 의심 식자재 개수)가 정렬의 1순위 신호여야 한다 — 기존엔 over_count+risk_alert_count만 봐서
  // 사입 의심 가맹점이 과다발주 가맹점보다 아래로 밀리는 경우가 있었다. under_count에 over_count의
  // 2배 가중치를 줘서 우선순위를 확실히 하되, over_count도 여전히(자금이 재고에 묶이는) 유의미한
  // 신호라 0으로 만들진 않는다. risk_alert_count는 이미 리스크로 등록/누적(occurrence_count 무관하게
  // 알림 건수)된 확정 신호라 under_count와 동급 가중치를 줘서, 반복 발생 이력이 있는 가맹점이
  // 단순히 이번 조회 기간 item 개수만 많은 가맹점에 밀리지 않게 한다.
  const score = a => a.under_count * 2 + a.over_count + a.risk_alert_count * 2;
  result.sort((a, b) => score(b) - score(a));

  // 화면(PurchaseAnomalies.jsx)이 "2배/0.7배"를 하드코딩하고 있어 PURCHASE_RATIOS를 바꾸면
  // 설명문만 거짓말이 된다.
  res.json({ anomalies: result, thresholds: { over: OVER_RATIO, under: UNDER_RATIO }, period: { from: fromISO, to: toISO } });
});

// ─── Toss Place 매출 동기화 ────────────────────────────
// 배달앱 연동을 켠 매장은 배민/쿠팡이츠/요기요 주문도 이 동기화 하나로 같이 들어온다 —
// 각 주문의 channel(토스 주문 원본의 order.source)로 구분된다. server/src/channels/toss.js 참고.
const { toss } = require('../channels');
const syncStoreSales = toss.syncStoreSales; // index.js 자동 동기화 루프에서 사용

// HQ 전용 — 기간 미지정 시 최대 5년치를 훑는 무거운 작업이라 가맹점 계정이 트리거하면 안 되고,
// 클라이언트에서도 이 기능(가맹점 목록 페이지의 "매출 동기화")은 HQ_ROLES 전원에게 열려있어 맞춤
router.post('/stores/:id/sync', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const store = await knex('stores').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!store) return res.status(404).json({ error: '가맹점 없음' });

  // 기간 미지정 시 전체 매출 기준으로 넉넉히 5년 전부터 가져옴
  const { from, to } = req.body;
  const fromDate = from || new Date(Date.now() - 5 * 365 * 86400000).toISOString().split('T')[0];
  const toDate = to || new Date().toISOString().split('T')[0];
  // 검증을 락 획득 뒤에 하면 400으로 빠져나가면서 finally가 없어 락이 TTL(30분)까지 남는다.
  // 예전엔 NaN이 그대로 from=NaN&to=NaN으로 토스 API에 나갔다.
  const fromTs = toss.kstDayStartTs(fromDate);
  const toTs = Math.min(toss.kstDayEndTs(toDate), Date.now()); // 미래 시각을 to로 보내지 않는다
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs)) return res.status(400).json({ error: DATE_PARAM_ERROR });
  if (toTs < fromTs) return res.status(400).json({ error: '조회 시작일이 종료일보다 늦습니다' });

  // syncInProgress Set 제거 — 크론(index.js)과 서로 다른 가드라 같은 매장에 동시 실행이 가능했다.
  // stores.sync_locked_at 조건부 UPDATE 락(syncLock.js)으로 통일해 프로세스가 달라도 겹치지 않게 한다.
  const { ok, stamp } = await acquireStoreSyncLock(knex, store.id);
  if (!ok) return res.status(409).json({ error: '이미 동기화가 진행 중입니다. 잠시 후 다시 시도해주세요' });

  try {
    const result = await toss.syncStoreSales(store, fromTs, toTs);
    // last_synced_at을 Date.now()로 밀면 안 된다 — 사용자가 종료일을 과거로 지정해 수동 동기화하면
    // (예: 신규 가맹점 온보딩 중 "3월 1일까지만" 조회) last_synced_at이 실제로 훑은 범위(toTs)를
    // 넘어 "지금"이 되어버리고, 그 이후 구간이 크론(index.js)의 "최근 2일" 창 밖으로 빠져 영구
    // 누락된다(3월~9월 매출이 다시는 동기화되지 않음). 실제로 조회한 상한(toTs)을 기록하되,
    // 이미 그보다 최신까지 동기화된 적이 있다면(예: 과거 구간을 나중에 재조회) 되돌리지 않는다.
    const prev = store.last_synced_at ? new Date(store.last_synced_at).getTime() : 0;
    if (result.failed === 0 && toTs > prev) await knex('stores').where({ id: store.id }).update({ last_synced_at: new Date(toTs).toISOString() });
    res.json({ ok: result.failed === 0, ...result, from: fromDate, to: toDate });
  } catch (err) {
    // toss.js가 던지는 에러에는 토스 API 응답 원문이 그대로 들어있어 브라우저로 보내면 안 됨
    console.error('Sync error:', err);
    res.status(500).json({ error: '매출 동기화에 실패했습니다' });
  } finally {
    await releaseStoreSyncLock(knex, store.id, stamp);
  }
});

// 대시보드용 채널별 매출 합계 — 실제로 동기화된 주문에 찍힌 channel 값(POS/배달앱 출처) 기준으로 그룹핑.
// 미리 정해둔 채널 목록이 아니라 실제 데이터에 있는 값만 나온다 — 배달앱 연동을 켠 매장만 배민/쿠팡이츠/요기요가 보임
router.get('/dashboard/channel-breakdown', requireAuth, async (req, res) => {
  const { store_id, from, to } = req.query;
  const brand_id = req.user.brand_id;
  const toISO = parseDateParam(to, new Date());
  const fromISO = parseDateParam(from, Date.now() - 30 * 86400000);
  if (!toISO || !fromISO) return res.status(400).json({ error: DATE_PARAM_ERROR });

  const isStoreRole = STORE_ROLES.includes(req.user.role);
  if (isStoreRole && !req.user.store_id) return res.json({ breakdown: [], period: { from: fromISO, to: toISO } });
  const sid = isStoreRole ? req.user.store_id : (store_id ? Number(store_id) : null);

  let q = knex('orders').where({ brand_id }).where('processed_at', '>=', fromISO).where('processed_at', '<=', toISO);
  if (sid) q = q.where({ store_id: sid });
  const rows = await q.groupBy('channel').select('channel').sum('total_amount as revenue').count('id as order_count');

  const breakdown = rows.map(r => ({
    channel: r.channel || 'POS',
    label: toss.labelFor(r.channel || 'POS'),
    revenue: Number(r.revenue) || 0,
    order_count: Number(r.order_count) || 0,
  })).sort((a, b) => b.revenue - a.revenue);
  res.json({ breakdown, period: { from: fromISO, to: toISO } });
});

// ─── 가맹점별 매출/발주 순위 ────────────────────────────
// 역할 검사가 없어 점주가 브랜드 전 가맹점의 매출·순위를 조회할 수 있었다.
router.get('/store-rankings', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const { from, to } = req.query;
  const brand_id = req.user.brand_id;
  const toISO = parseDateParam(to, new Date());
  const fromISO = parseDateParam(from, Date.now() - 30 * 86400000);
  if (!toISO || !fromISO) return res.status(400).json({ error: DATE_PARAM_ERROR });

  // 폐점 가맹점은 더 이상 운영 중이 아니므로 순위/발주율 통계에 계속 끼어들지 않도록 제외
  const salesRows = await knex('sales_items as si')
    .join('stores as s', 'si.store_id', 's.id')
    .where('si.brand_id', brand_id).where('s.is_open', true)
    .where('si.sold_at', '>=', fromISO).where('si.sold_at', '<=', toISO)
    .groupBy('si.store_id', 's.name')
    .select('si.store_id', 's.name as store_name')
    .sum('si.amount as revenue')
    .countDistinct('si.toss_order_id as order_count')
    .orderBy('revenue', 'desc');

  const orderRows = await knex('purchase_orders as po')
    .join('stores as s', 'po.store_id', 's.id')
    .where('po.brand_id', brand_id).where('s.is_open', true)
    .whereNotIn('po.status', [ORDER_STATUSES.DRAFT, ORDER_STATUSES.CANCELED])
    .where('po.created_at', '>=', toDbTime(fromISO)).where('po.created_at', '<=', toDbTime(toISO))
    .groupBy('po.store_id', 's.name')
    .select('po.store_id', 's.name as store_name')
    .sum('po.total_amount as order_amount')
    .count('po.id as order_count')
    .orderBy('order_amount', 'desc');

  const salesByStore = new Map(salesRows.map(r => [r.store_id, { store_name: r.store_name, revenue: Number(r.revenue || 0) }]));
  const orderByStore = new Map(orderRows.map(r => [r.store_id, { store_name: r.store_name, order_amount: Number(r.order_amount || 0) }]));
  const allStoreIds = new Set([...salesByStore.keys(), ...orderByStore.keys()]);

  // 발주율 = 발주금액 / 매출 — 높을수록 매출에 비해 발주(원가 지출)가 많다는 뜻
  const efficiencyRanking = [...allStoreIds].map(store_id => {
    const sale = salesByStore.get(store_id);
    const order = orderByStore.get(store_id);
    const revenue = sale?.revenue || 0;
    const order_amount = order?.order_amount || 0;
    return {
      store_id,
      store_name: sale?.store_name || order?.store_name,
      revenue, order_amount,
      ratio: revenue > 0 ? Math.round((order_amount / revenue) * 1000) / 10 : null, // %
    };
  }).sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));

  res.json({
    salesRanking: salesRows.map(r => ({ store_id: r.store_id, store_name: r.store_name, revenue: Number(r.revenue || 0), order_count: Number(r.order_count || 0) })),
    orderRanking: orderRows.map(r => ({ store_id: r.store_id, store_name: r.store_name, order_amount: Number(r.order_amount || 0), order_count: Number(r.order_count || 0) })),
    efficiencyRanking,
    period: { from: fromISO, to: toISO },
  });
});

// ─── 정산 리포트 (가맹점별 결제/환불 집계) ──────────────
router.get('/settlement', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const { from, to } = req.query;
  const brand_id = req.user.brand_id;
  const toISO = parseDateParam(to, new Date());
  const fromISO = parseDateParam(from, Date.now() - 30 * 86400000);
  if (!toISO || !fromISO) return res.status(400).json({ error: DATE_PARAM_ERROR });

  const rows = await knex('purchase_orders as po')
    .join('stores as s', 'po.store_id', 's.id')
    .where('po.brand_id', brand_id)
    .whereNotNull('po.paid_at')
    .where('po.paid_at', '>=', fromISO).where('po.paid_at', '<=', toISO)
    .select('po.store_id', 's.name as store_name', 'po.confirmed_amount', 'po.total_amount', 'po.refunded_amount');

  const byStore = new Map();
  for (const r of rows) {
    const gross = Math.round(r.confirmed_amount ?? r.total_amount);
    const refunded = Math.round(r.refunded_amount || 0);
    const cur = byStore.get(r.store_id) || { store_id: r.store_id, store_name: r.store_name, order_count: 0, gross: 0, refunded: 0 };
    cur.order_count += 1;
    cur.gross += gross;
    cur.refunded += refunded;
    byStore.set(r.store_id, cur);
  }

  const settlement = [...byStore.values()]
    .map(s => ({ ...s, net: s.gross - s.refunded }))
    .sort((a, b) => b.net - a.net);

  const totals = settlement.reduce((acc, s) => ({
    order_count: acc.order_count + s.order_count,
    gross: acc.gross + s.gross,
    refunded: acc.refunded + s.refunded,
    net: acc.net + s.net,
  }), { order_count: 0, gross: 0, refunded: 0, net: 0 });

  // 상품별 매출 분해 — 결제완료(paid_at) 발주서의 품목 단위로 집계, 품목별 환불 수량을 반영한 순매출(net)까지 계산
  const itemRows = await knex('purchase_order_items as poi')
    .join('purchase_orders as po', 'poi.order_id', 'po.id')
    .where('po.brand_id', brand_id)
    .whereNotNull('po.paid_at')
    .where('po.paid_at', '>=', fromISO).where('po.paid_at', '<=', toISO)
    .select('poi.product_name', 'poi.unit_price', 'poi.quantity', 'poi.confirmed_quantity', 'poi.refunded_quantity', 'poi.amount');

  const byProduct = new Map();
  for (const r of itemRows) {
    const qty = r.confirmed_quantity ?? r.quantity;
    const refundedAmount = Math.round((r.refunded_quantity || 0) * r.unit_price);
    const gross = Math.round(r.amount);
    const cur = byProduct.get(r.product_name) || { product_name: r.product_name, qty: 0, gross: 0, refunded: 0 };
    cur.qty += qty;
    cur.gross += gross;
    cur.refunded += refundedAmount;
    byProduct.set(r.product_name, cur);
  }
  const byProductList = [...byProduct.values()]
    .map(p => ({ ...p, net: p.gross - p.refunded }))
    .sort((a, b) => b.net - a.net);

  // 직전 동일 기간 대비 — 기간 길이를 그대로 앞으로 이동해 전 기간 합계만 비교 (트렌드 파악용)
  const periodMs = new Date(toISO).getTime() - new Date(fromISO).getTime();
  const prevToISO = fromISO;
  const prevFromISO = new Date(new Date(fromISO).getTime() - periodMs).toISOString();
  const prevRows = await knex('purchase_orders as po')
    .where('po.brand_id', brand_id)
    .whereNotNull('po.paid_at')
    .where('po.paid_at', '>=', prevFromISO).where('po.paid_at', '<', prevToISO)
    .select('po.confirmed_amount', 'po.total_amount', 'po.refunded_amount');
  const previousTotals = prevRows.reduce((acc, r) => {
    const gross = Math.round(r.confirmed_amount ?? r.total_amount);
    const refunded = Math.round(r.refunded_amount || 0);
    return { order_count: acc.order_count + 1, gross: acc.gross + gross, refunded: acc.refunded + refunded, net: acc.net + (gross - refunded) };
  }, { order_count: 0, gross: 0, refunded: 0, net: 0 });

  res.json({
    settlement, totals, byProduct: byProductList,
    previousPeriod: { totals: previousTotals, from: prevFromISO, to: prevToISO },
    period: { from: fromISO, to: toISO },
  });
});

// ─── 감사 로그 ────────────────────────────────────────
router.get('/audit-log', requireAuth, requireRole('SUPER_ADMIN', 'HQ_ADMIN'), async (req, res) => {
  const { entity_type, limit } = req.query;
  const q = knex('audit_log as a')
    .leftJoin('users as u', 'a.user_id', 'u.id')
    .select('a.*', 'u.name as user_name')
    .where('a.brand_id', req.user.brand_id)
    .orderBy('a.created_at', 'desc')
    .limit(Math.min(Number(limit) || 200, 1000));
  if (entity_type) q.where('a.entity_type', entity_type);
  res.json(await q);
});

module.exports = router;
module.exports.syncStoreSales = syncStoreSales;
module.exports.getIngredientComparison = getIngredientComparison;
