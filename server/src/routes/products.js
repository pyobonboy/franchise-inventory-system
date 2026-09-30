const createAsyncRouter = require('../middleware/asyncRouter');
const router = createAsyncRouter();
const { knex } = require('../db/schema');
const { requireAuth, requireRole, HQ_ROLES, LOGISTICS_ROLES, ADMIN_ROLES } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { getIngredientComparison } = require('./api');
const { ORDER_STATUSES } = require('../constants');

function isStoreRole(role) {
  return ['STORE_OWNER', 'STORE_STAFF'].includes(role);
}

router.get('/', requireAuth, async (req, res) => {
  const products = await knex('products')
    .where({ brand_id: req.user.brand_id, is_active: true })
    .orderBy('name');
  res.json(products);
});

// 추천 발주량: 최근 7일 판매량 × 레시피 사용량으로 예상 소진량을 구하고, 현재 재고와 비교해서
// "한 발주 주기 동안 더 필요할 것으로 보이는 양"을 상품(발주단위) 기준으로 환산해 보여준다.
// 사입이상모니터링에서 쓰는 것과 같은 추정 로직(getIngredientComparison)을 재사용한다.
router.get('/recommendations', requireAuth, async (req, res) => {
  const store_id = isStoreRole(req.user.role) ? req.user.store_id : Number(req.query.store_id);
  if (!store_id) return res.json({});

  const toISO = new Date().toISOString();
  const fromISO = new Date(Date.now() - 7 * 86400000).toISOString();
  const comparison = await getIngredientComparison(req.user.brand_id, store_id, fromISO, toISO);
  const estimatedByName = Object.fromEntries(comparison.map(c => [c.name, c.estimated]));

  const products = await knex('products').where({ brand_id: req.user.brand_id, is_active: true });
  const baseIngredients = await knex('ingredients')
    .whereIn('id', products.map(p => p.ingredient_id).filter(Boolean));
  const baseNameById = Object.fromEntries(baseIngredients.map(i => [i.id, i.name]));

  const storeIngredients = await knex('ingredients').where({ brand_id: req.user.brand_id, store_id });
  const stockByName = Object.fromEntries(storeIngredients.map(i => [i.name, i.stock || 0]));

  // 이미 발주했지만 아직 납품(재고 반영)되지 않은 물량은 현재 재고에 안 잡혀있다.
  // 이걸 빼지 않으면 "어제 이미 발주한 재료를 오늘 또 추천"하는 과다추천 문제가 생긴다.
  const pendingItems = await knex('purchase_order_items as poi')
    .join('purchase_orders as po', 'poi.order_id', 'po.id')
    .where('po.brand_id', req.user.brand_id).where('po.store_id', store_id)
    .where('po.stock_applied', false)
    .whereNotIn('po.status', [ORDER_STATUSES.DRAFT, ORDER_STATUSES.CANCELED])
    .select('poi.product_id', 'poi.quantity', 'poi.confirmed_quantity');
  const pendingBaseByName = {};
  // 발주 품목마다 products.find()로 O(n)씩 훑으면 전체가 O(n×m)이 되어 상품 수가 늘수록 느려진다.
  const productById = new Map(products.map(p => [p.id, p]));
  for (const item of pendingItems) {
    const p = productById.get(item.product_id);
    if (!p) continue;
    const ingName = p.ingredient_id ? baseNameById[p.ingredient_id] : p.name;
    if (!ingName) continue;
    const qty = item.confirmed_quantity ?? item.quantity;
    pendingBaseByName[ingName] = (pendingBaseByName[ingName] || 0) + qty * (p.unit_conversion || 1);
  }

  const result = {};
  for (const p of products) {
    const ingName = p.ingredient_id ? baseNameById[p.ingredient_id] : p.name;
    if (!ingName) continue;
    const estimated = estimatedByName[ingName];
    if (estimated === undefined) continue; // 최근 7일간 판매 실적이 없는 메뉴 재료는 추천하지 않음
    const currentStock = stockByName[ingName] || 0;
    const pendingIncoming = pendingBaseByName[ingName] || 0;
    const neededBase = Math.max(0, estimated - currentStock - pendingIncoming);
    const recommendedQty = Math.ceil(neededBase / (p.unit_conversion || 1));
    if (recommendedQty > 0) result[p.id] = recommendedQty;
  }
  res.json(result);
});

router.post('/', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const { name, unit, unit_conversion, base_unit, price, ingredient_id, category } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '상품명을 입력해주세요' });
  if (name.trim().length > 200) return res.status(400).json({ error: '상품명은 200자를 넘을 수 없습니다' });
  if (!unit || !String(unit).trim()) return res.status(400).json({ error: '발주 단위를 선택해주세요' });
  if (!(base_unit || unit) || !String(base_unit || unit).trim()) return res.status(400).json({ error: '기본 단위를 선택해주세요' });
  if (price !== undefined && (Number(price) < 0 || !Number.isFinite(Number(price)))) {
    return res.status(400).json({ error: '가격은 0 이상의 값이어야 합니다' });
  }
  // unit_conversion(1발주단위 = N기본단위)은 납품 시 재고 반영량 계산의 곱셈 인자로 쓰인다(applyItemStock).
  // 0 이하나 NaN이 들어가면 재고가 전혀 안 늘어나거나 음수 방향으로 반영되는 사고로 이어진다.
  if (unit_conversion !== undefined && unit_conversion !== null && (!Number.isFinite(Number(unit_conversion)) || Number(unit_conversion) <= 0)) {
    return res.status(400).json({ error: '단위 환산 값은 0보다 큰 숫자여야 합니다' });
  }
  if (category !== undefined && category !== null && String(category).trim().length > 100) {
    return res.status(400).json({ error: '카테고리는 100자를 넘을 수 없습니다' });
  }
  // ingredient_id는 브랜드 소속 확인 없이 저장하면, 납품 시 재고 반영(applyItemStock)이 다른 브랜드의
  // 재료명/단위를 그대로 가져와 버릴 수 있다 (해당 함수는 brand_id로 다시 거르지 않고 id로만 조회함)
  if (ingredient_id) {
    const ing = await knex('ingredients').where({ id: ingredient_id, brand_id: req.user.brand_id }).first();
    if (!ing) return res.status(400).json({ error: '존재하지 않는 식자재입니다' });
  }
  // 이름이 같은 상품이 있으면 발주서 납품 시 재고 반영(이름 매칭)이 어느 쪽 상품인지 혼동될 수 있음
  const dup = await knex('products').where({ brand_id: req.user.brand_id, name: name.trim(), is_active: true }).first();
  if (dup) return res.status(400).json({ error: '같은 이름의 상품이 이미 있습니다' });
  const [{ id }] = await knex('products').insert({
    brand_id: req.user.brand_id,
    name: name.trim(), unit, unit_conversion: unit_conversion || 1,
    base_unit: base_unit || unit, price: Math.round(price || 0),
    ingredient_id: ingredient_id || null,
    category: category ? category.trim() : null,
  }).returning('id');
  await logAudit(req.user.brand_id, req.user.id, 'PRODUCT', id, 'CREATE', null, req.body);
  res.json({ id });
});

router.put('/:id', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  const existing = await knex('products').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  const { name, unit, unit_conversion, base_unit, price, ingredient_id, is_active, category } = req.body;
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: '상품명을 입력해주세요' });
  if (name !== undefined && name.trim().length > 200) return res.status(400).json({ error: '상품명은 200자를 넘을 수 없습니다' });
  if (unit !== undefined && !String(unit).trim()) return res.status(400).json({ error: '발주 단위를 선택해주세요' });
  if (base_unit !== undefined && !String(base_unit).trim()) return res.status(400).json({ error: '기본 단위를 선택해주세요' });
  if (price !== undefined && (Number(price) < 0 || !Number.isFinite(Number(price)))) {
    return res.status(400).json({ error: '가격은 0 이상의 값이어야 합니다' });
  }
  // POST와 동일한 이유 — 이 값이 납품 시 재고 반영량의 곱셈 인자로 쓰인다
  if (unit_conversion !== undefined && unit_conversion !== null && (!Number.isFinite(Number(unit_conversion)) || Number(unit_conversion) <= 0)) {
    return res.status(400).json({ error: '단위 환산 값은 0보다 큰 숫자여야 합니다' });
  }
  if (category !== undefined && category !== null && String(category).trim().length > 100) {
    return res.status(400).json({ error: '카테고리는 100자를 넘을 수 없습니다' });
  }
  // ingredient_id를 null로 보내 연결 해제하는 것은 허용하되(선택 안함), 값이 있으면 브랜드 소속을 확인한다
  if (ingredient_id !== undefined && ingredient_id !== null) {
    const ing = await knex('ingredients').where({ id: ingredient_id, brand_id: req.user.brand_id }).first();
    if (!ing) return res.status(400).json({ error: '존재하지 않는 식자재입니다' });
  }
  if (name && name.trim() !== existing.name) {
    const dup = await knex('products').where({ brand_id: req.user.brand_id, name: name.trim(), is_active: true })
      .whereNot('id', existing.id).first();
    if (dup) return res.status(400).json({ error: '같은 이름의 상품이 이미 있습니다' });
  }
  const next = {
    name: name !== undefined ? name.trim() : existing.name,
    unit: unit ?? existing.unit,
    unit_conversion: unit_conversion ?? existing.unit_conversion,
    base_unit: base_unit ?? existing.base_unit,
    price: price !== undefined ? Math.round(price) : existing.price,
    ingredient_id: ingredient_id !== undefined ? ingredient_id : existing.ingredient_id,
    is_active: is_active !== undefined ? is_active : existing.is_active,
    category: category !== undefined ? (category ? category.trim() : null) : existing.category,
  };
  await knex('products').where({ id: req.params.id, brand_id: req.user.brand_id }).update(next);
  if (next.price !== existing.price) {
    await logAudit(req.user.brand_id, req.user.id, 'PRODUCT', existing.id, 'UPDATE', { price: existing.price }, { price: next.price });
    // 단가가 바로 모든 신규 발주에 적용되는데 가맹점에 사전 공지 없이 조용히 바뀌던 문제 —
    // 공지사항(브랜드 전체)에 자동으로 변경 내역을 올려서 가맹점이 다음 발주 전에 알 수 있게 함
    await knex('notices').insert({
      brand_id: req.user.brand_id, store_id: null,
      title: `[단가변경] ${next.name}`,
      content: `${next.name}의 발주 단가가 ${existing.price.toLocaleString()}원에서 ${next.price.toLocaleString()}원으로 변경되었습니다.`,
      created_by: req.user.id,
    });
  }
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireRole(...LOGISTICS_ROLES), async (req, res) => {
  await knex('products').where({ id: req.params.id, brand_id: req.user.brand_id })
    .update({ is_active: false });
  await logAudit(req.user.brand_id, req.user.id, 'PRODUCT', Number(req.params.id), 'DELETE', null, null);
  res.json({ ok: true });
});

module.exports = router;
