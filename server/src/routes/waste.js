const createAsyncRouter = require('../middleware/asyncRouter');
const router = createAsyncRouter();
const { knex } = require('../db/schema');
const { requireAuth, LOGISTICS_ROLES } = require('../middleware/auth');
const { checkHighWaste } = require('./risks');
const { logStockMovement } = require('../stockLedger');
const { STOCK_LEDGER_TYPES } = require('../constants');

function isStoreRole(role) {
  return ['STORE_OWNER', 'STORE_STAFF'].includes(role);
}

router.get('/', requireAuth, async (req, res) => {
  const { store_id, from, to } = req.query;
  const q = knex('waste_logs as w')
    .join('stores as s', 'w.store_id', 's.id')
    .select('w.*', 's.name as store_name')
    .where('w.brand_id', req.user.brand_id)
    .orderBy('w.waste_date', 'desc')
    // 상한 없이 전체 폐기 내역을 다 내려주면 누적 기간이 길어질수록 응답이 무거워진다 — 상한을 두되
    // limit 쿼리로 필요하면 더 넓게(최대 2000) 볼 수 있게 한다.
    .limit(Math.min(Number(req.query.limit) || 2000, 2000));
  // 가맹점 역할은 쿼리파라미터로 다른 가맹점을 조회할 수 없도록 강제
  if (isStoreRole(req.user.role)) q.where('w.store_id', req.user.store_id);
  else if (store_id) q.where('w.store_id', store_id);
  if (from) q.where('w.waste_date', '>=', from);
  if (to) q.where('w.waste_date', '<=', to);
  res.json(await q);
});

router.post('/', requireAuth, async (req, res) => {
  const { waste_date, ingredient_id, ingredient_name, quantity, unit, reason, memo } = req.body;
  const store_id = req.user.store_id;
  if (!store_id) return res.status(400).json({ error: '가맹점 정보 없음' });

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: '폐기 수량은 0보다 큰 값이어야 합니다' });
  }
  // waste_date/ingredient_name/unit/reason은 DB에 NOT NULL로 걸려있어, 비어있는 채로 들어오면
  // insert가 그대로 예외를 던져 500이 난다 — 사용자에게 무엇이 빠졌는지 알려주기 위해 미리 걸러낸다
  if (!waste_date || !/^\d{4}-\d{2}-\d{2}$/.test(waste_date)) {
    return res.status(400).json({ error: '폐기일을 입력해주세요' });
  }
  if (!reason || !reason.trim()) return res.status(400).json({ error: '폐기 사유를 입력해주세요' });
  if (reason.trim().length > 100) return res.status(400).json({ error: '폐기 사유는 100자를 넘을 수 없습니다' });
  if (!unit || !String(unit).trim()) return res.status(400).json({ error: '단위를 입력해주세요' });
  if (!ingredient_name || !String(ingredient_name).trim()) return res.status(400).json({ error: '식자재를 선택해주세요' });
  if (memo !== undefined && memo !== null && String(memo).length > 2000) {
    return res.status(400).json({ error: '메모는 2000자를 넘을 수 없습니다' });
  }

  let ingredient = null;
  if (ingredient_id) {
    ingredient = await knex('ingredients').where({ id: ingredient_id, brand_id: req.user.brand_id, store_id }).first();
    if (!ingredient) return res.status(400).json({ error: '해당 가맹점의 재료가 아닙니다' });
    if (qty > ingredient.stock) {
      return res.status(400).json({ error: `현재 재고(${ingredient.stock}${ingredient.unit})보다 많은 양을 폐기할 수 없습니다` });
    }
  }

  const id = await knex.transaction(async (trx) => {
    const [{ id: insertedId }] = await trx('waste_logs').insert({
      brand_id: req.user.brand_id,
      store_id, ingredient_id: ingredient_id || null,
      ingredient_name, quantity: qty, unit, reason, memo,
      waste_date, created_by: req.user.id,
    }).returning('id');

    // 재고 차감
    if (ingredient) {
      await trx('ingredients').where({ id: ingredient.id }).decrement('stock', qty);
      await logStockMovement(trx, {
        brand_id: req.user.brand_id, store_id, ingredient_id: ingredient.id,
        type: 'WASTE', delta: -qty,
        before_stock: ingredient.stock, after_stock: ingredient.stock - qty,
        ref_type: 'waste_log', ref_id: insertedId, created_by: req.user.id,
      });
    }
    return insertedId;
  });

  // 폐기 과다 리스크 체크 (비동기 - 응답 블록 안함)
  checkHighWaste(req.user.brand_id, store_id).catch(() => {});

  res.json({ id });
});

router.delete('/:id', requireAuth, async (req, res) => {
  // HQ_ACCOUNTING(조회 전용)이 폐기 취소로 재고를 늘릴 수 있었다.
  if (!isStoreRole(req.user.role) && !LOGISTICS_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: '권한이 없습니다' });
  }
  const log = await knex('waste_logs').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!log) return res.status(404).json({ error: '없음' });
  if (isStoreRole(req.user.role) && log.store_id !== req.user.store_id) {
    return res.status(403).json({ error: '권한 없음' });
  }
  await knex.transaction(async (trx) => {
    await trx('waste_logs').where({ id: log.id }).delete();
    // 폐기 기록 취소 시 차감했던 재고를 복원
    if (log.ingredient_id) {
      const ing = await trx('ingredients').where({ id: log.ingredient_id }).first();
      if (ing) {
        await trx('ingredients').where({ id: log.ingredient_id }).increment('stock', log.quantity);
        await logStockMovement(trx, {
          brand_id: req.user.brand_id, store_id: log.store_id, ingredient_id: log.ingredient_id,
          type: STOCK_LEDGER_TYPES.WASTE_CANCEL, delta: log.quantity,
          before_stock: ing.stock, after_stock: ing.stock + log.quantity,
          ref_type: 'waste_log', ref_id: log.id, created_by: req.user.id,
        });
      }
    }
  });
  res.json({ ok: true });
});

// 본사 집계
router.get('/summary', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const q = knex('waste_logs as w')
    .join('stores as s', 'w.store_id', 's.id')
    .select('s.name as store_name', 'w.ingredient_name', 'w.unit', 'w.reason')
    .sum('w.quantity as total_quantity')
    .where('w.brand_id', req.user.brand_id)
    .groupBy('w.store_id', 'w.ingredient_name', 'w.unit', 'w.reason')
    .orderBy('total_quantity', 'desc');
  // 가맹점 필터가 없어 점주가 타 가맹점 폐기 내역을 그대로 조회할 수 있었다.
  if (isStoreRole(req.user.role)) {
    if (!req.user.store_id) return res.json([]);
    q.where('w.store_id', req.user.store_id);
  } else if (req.query.store_id) q.where('w.store_id', req.query.store_id);
  if (from) q.where('w.waste_date', '>=', from);
  if (to) q.where('w.waste_date', '<=', to);
  res.json(await q);
});

module.exports = router;
