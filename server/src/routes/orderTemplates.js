const createAsyncRouter = require('../middleware/asyncRouter');
const router = createAsyncRouter();
const { knex } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { syncOrderTemplateItems } = require('../dbHelpers');

// 정기 발주 템플릿 — 매주 거의 같은 품목을 발주하는 가맹점이 매번 장바구니를 새로 채우지 않고
// 저장해둔 구성을 한 번에 불러올 수 있게 함 (가맹점별로만 저장/조회)
router.get('/', requireAuth, async (req, res) => {
  if (!req.user.store_id) return res.json([]);
  const rows = await knex('order_templates')
    .where({ brand_id: req.user.brand_id, store_id: req.user.store_id })
    .orderBy('created_at', 'desc');
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items) })));
});

router.post('/', requireAuth, async (req, res) => {
  if (!req.user.store_id) return res.status(400).json({ error: '가맹점 정보 없음' });
  const { name, items } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '템플릿 이름을 입력해주세요' });
  if (name.trim().length > 200) return res.status(400).json({ error: '템플릿 이름은 200자를 넘을 수 없습니다' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: '담을 상품이 없습니다' });
  // 상한이 없어 5,000개짜리 템플릿을 저장할 수 있었고, 그대로 장바구니에 불러오면 발주 검증(200개 상한)에서야
  // 막혀 사용자가 이유를 알 수 없었다.
  if (items.length > 500) return res.status(400).json({ error: '템플릿 항목은 500개를 넘을 수 없습니다' });

  // product_id를 브랜드 소속 확인 없이 그대로 저장하면, 다른 브랜드의 상품 id를 넣어 나중에
  // 이 템플릿을 불러올 때(불러오기는 클라이언트가 자기 브랜드 상품 목록에서 다시 매칭하므로 실질적 피해는
  // 없지만) 이 템플릿을 통해 다른 브랜드 상품 id 존재 여부를 흘리게 될 수 있다. 확인은 한 번에.
  const productIds = [...new Set(items.filter(i => i && i.product_id).map(i => Number(i.product_id)))];
  const products = productIds.length
    ? await knex('products').where({ brand_id: req.user.brand_id }).whereIn('id', productIds)
    : [];
  const validProductIds = new Set(products.map(p => p.id));

  // 실제 발주 생성(orders.js의 resolveItemPrices)이 product_id가 있으면 그때 다시 서버 단가로
  // 덮어쓰기 때문에, 여기 저장된 unit_price는 "템플릿 목록에 표시만 되는 참고값"이라 클라이언트가
  // 보낸 값을 그대로 써도 실제 결제/발주 금액에는 영향이 없다 — 다만 NaN/음수가 들어가 화면이
  // 깨지는 것만 막는다.
  for (const item of items) {
    if (!item || typeof item !== 'object') return res.status(400).json({ error: '담을 상품 정보가 올바르지 않습니다' });
    if (item.product_id && !validProductIds.has(Number(item.product_id))) {
      return res.status(400).json({ error: '존재하지 않는 상품이 포함되어 있습니다' });
    }
    if (!item.product_name || !String(item.product_name).trim()) {
      return res.status(400).json({ error: '상품명이 없는 항목이 있습니다' });
    }
    if (String(item.product_name).trim().length > 200) {
      return res.status(400).json({ error: '상품명은 200자를 넘을 수 없습니다' });
    }
    if (!item.unit || !String(item.unit).trim()) {
      return res.status(400).json({ error: '단위가 없는 항목이 있습니다' });
    }
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: `${item.product_name}의 수량이 올바르지 않습니다` });
    }
    if (item.unit_price !== undefined && (!Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0)) {
      return res.status(400).json({ error: `${item.product_name}의 단가가 올바르지 않습니다` });
    }
  }

  const [{ id }] = await knex('order_templates').insert({
    brand_id: req.user.brand_id, store_id: req.user.store_id,
    name: name.trim(), items: JSON.stringify(items),
  }).returning('id');
  try {
    await syncOrderTemplateItems(knex, id, items);
  } catch (error) {
    console.error('[order_template_items] 템플릿 생성 이중 기록 실패:', error.message);
  }
  res.json({ id });
});

router.delete('/:id', requireAuth, async (req, res) => {
  if (!req.user.store_id) return res.status(400).json({ error: '가맹점 정보 없음' });
  await knex('order_templates').where({ id: req.params.id, brand_id: req.user.brand_id, store_id: req.user.store_id }).delete();
  res.json({ ok: true });
});

module.exports = router;
