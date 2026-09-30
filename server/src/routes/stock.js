const createAsyncRouter = require('../middleware/asyncRouter');
const router = createAsyncRouter();
const { knex } = require('../db/schema');
const { requireAuth, LOGISTICS_ROLES } = require('../middleware/auth');
const { logStockMovement } = require('../stockLedger');
const { STOCK_LEDGER_TYPES } = require('../constants');
const { toDbTime, kstDayRange } = require('../dbTime');

function isStoreRole(role) {
  return ['STORE_OWNER', 'STORE_STAFF'].includes(role);
}

// api.js의 parseDateParam과 같은 이유로 필요 — 값이 있는데 파싱 불가하면 kstDayRange 내부의
// new Date(...).toISOString()이 RangeError를 던져 500이 난다. 라우트 모듈 간 의존을 만들지 않기 위해
// 여기서도 똑같은 검사를 별도로 둔다(값이 없으면 kstDayRange를 아예 호출하지 않으므로 통과시켜도 안전).
function isInvalidDateParam(value) {
  return !!value && Number.isNaN(new Date(value).getTime());
}

// 가맹점이 쓸 수 있는 store_id 결정 — 가맹점 역할은 본인 매장으로 강제, 본사는 쿼리파라미터로 지정
function resolveStoreId(req) {
  if (isStoreRole(req.user.role)) return req.user.store_id || null;
  return req.query.store_id ? Number(req.query.store_id) : null;
}

// ── 실사 재고 조정 ────────────────────────────────────
router.get('/adjustments', requireAuth, async (req, res) => {
  const storeId = resolveStoreId(req);
  if (!storeId) return res.json([]);
  const rows = await knex('stock_adjustments as a')
    .join('ingredients as i', 'a.ingredient_id', 'i.id')
    .leftJoin('users as u', 'a.created_by', 'u.id')
    .select('a.*', 'i.name as ingredient_name', 'i.unit', 'u.name as created_by_name')
    .where({ 'a.brand_id': req.user.brand_id, 'a.store_id': storeId })
    .orderBy('a.created_at', 'desc')
    .limit(100);
  res.json(rows);
});

router.post('/adjustments', requireAuth, async (req, res) => {
  // 실사조정은 재고를 절대값으로 덮어쓰므로 조회 전용 역할이 손대면 안 된다.
  if (!isStoreRole(req.user.role) && !LOGISTICS_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: '권한이 없습니다' });
  }
  const storeId = isStoreRole(req.user.role) ? req.user.store_id : req.body.store_id;
  if (!storeId) return res.status(400).json({ error: '가맹점을 지정해주세요' });
  const { ingredient_id, counted_stock, memo } = req.body;
  const counted = Number(counted_stock);
  if (!Number.isFinite(counted) || counted < 0) {
    return res.status(400).json({ error: '실사 수량은 0 이상이어야 합니다' });
  }
  const ingredient = await knex('ingredients').where({ id: ingredient_id, brand_id: req.user.brand_id, store_id: storeId }).first();
  if (!ingredient) return res.status(400).json({ error: '해당 가맹점의 재료가 아닙니다' });

  const before = ingredient.stock || 0;
  const diff = counted - before;
  const id = await knex.transaction(async (trx) => {
    await trx('ingredients').where({ id: ingredient.id }).update({ stock: counted });
    const [{ id: adjId }] = await trx('stock_adjustments').insert({
      brand_id: req.user.brand_id, store_id: storeId, ingredient_id: ingredient.id,
      before_stock: before, counted_stock: counted, diff,
      memo: memo || null, created_by: req.user.id,
    }).returning('id');
    if (diff !== 0) {
      await logStockMovement(trx, {
        brand_id: req.user.brand_id, store_id: storeId, ingredient_id: ingredient.id,
        type: STOCK_LEDGER_TYPES.ADJUSTMENT, delta: diff, before_stock: before, after_stock: counted,
        memo: memo || null, ref_type: 'stock_adjustment', ref_id: adjId, created_by: req.user.id,
      });
    }
    return adjId;
  });
  res.json({ id, diff });
});

// ── 상품별 거래 수불 ──────────────────────────────────
router.get('/ledger', requireAuth, async (req, res) => {
  const storeId = resolveStoreId(req);
  if (!storeId) return res.json([]);
  const { ingredient_id, from, to } = req.query;
  if (isInvalidDateParam(from) || isInvalidDateParam(to)) {
    return res.status(400).json({ error: '조회 기간(from/to) 형식이 올바르지 않습니다' });
  }
  const q = knex('stock_ledger as l')
    .join('ingredients as i', 'l.ingredient_id', 'i.id')
    .leftJoin('users as u', 'l.created_by', 'u.id')
    .select('l.*', 'i.name as ingredient_name', 'i.unit', 'u.name as created_by_name')
    .where({ 'l.brand_id': req.user.brand_id, 'l.store_id': storeId })
    .orderBy('l.created_at', 'desc')
    .limit(500);
  if (ingredient_id) q.where('l.ingredient_id', ingredient_id);
  // stock_ledger.created_at은 knex.fn.now() 기본값이라 사용자가 넣은 'YYYY-MM-DD' 문자열과 직접
  // 비교하면 sqlite에서 형식이 어긋나고, 하루의 경계도 UTC 기준이 되어 KST 00~09시 기록이 빠졌다.
  if (from) q.where('l.created_at', '>=', toDbTime(kstDayRange(from).startIso));
  if (to) q.where('l.created_at', '<=', toDbTime(kstDayRange(to).endIso));
  res.json(await q);
});

module.exports = router;
