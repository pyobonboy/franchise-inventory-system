const createAsyncRouter = require('../middleware/asyncRouter');
const router = createAsyncRouter();
const { knex } = require('../db/schema');
const { requireAuth, requireRole, HQ_ROLES, STORE_ROLES } = require('../middleware/auth');

function isStoreRole(role) {
  return STORE_ROLES.includes(role);
}

// 본사: 공지 목록 — 가맹점별로 몇 명이 읽었는지까지 같이 보여준다 (마켓봄의 "누락없이 공지" 개념)
router.get('/', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const notices = await knex('notices as n')
    .leftJoin('stores as s', 'n.store_id', 's.id')
    .select('n.*', 's.name as store_name')
    .where('n.brand_id', req.user.brand_id)
    .orderBy('n.created_at', 'desc')
    // 상한 없이 전체 공지를 다 내려주면 공지가 쌓일수록 응답이 무거워진다 — 상한을 두되
    // limit 쿼리로 필요하면 더 넓게(최대 2000) 볼 수 있게 한다.
    .limit(Math.min(Number(req.query.limit) || 2000, 2000));

  const counts = await knex('notice_reads as nr')
    .join('notices as n', 'nr.notice_id', 'n.id')
    .where('n.brand_id', req.user.brand_id)
    .select('nr.notice_id')
    .count('nr.id as cnt')
    .groupBy('nr.notice_id');
  const countMap = Object.fromEntries(counts.map(c => [c.notice_id, Number(c.cnt)]));

  res.json(notices.map(n => ({ ...n, read_count: countMap[n.id] || 0 })));
});

router.post('/', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const { title, content, store_id } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: '제목을 입력해주세요' });
  if (title.trim().length > 200) return res.status(400).json({ error: '제목은 200자를 넘을 수 없습니다' });
  if (!content || !content.trim()) return res.status(400).json({ error: '내용을 입력해주세요' });
  if (content.trim().length > 10000) return res.status(400).json({ error: '내용은 10000자를 넘을 수 없습니다' });
  if (store_id) {
    const store = await knex('stores').where({ id: store_id, brand_id: req.user.brand_id }).first();
    if (!store) return res.status(400).json({ error: '존재하지 않는 가맹점입니다' });
  }
  const [{ id }] = await knex('notices').insert({
    brand_id: req.user.brand_id, store_id: store_id || null,
    title: title.trim(), content: content.trim(), created_by: req.user.id,
  }).returning('id');
  res.json({ id });
});

router.put('/:id', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  const existing = await knex('notices').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!existing) return res.status(404).json({ error: '없음' });
  const { title, content, is_active } = req.body;
  if (title !== undefined && !title.trim()) return res.status(400).json({ error: '제목을 입력해주세요' });
  if (title !== undefined && title.trim().length > 200) return res.status(400).json({ error: '제목은 200자를 넘을 수 없습니다' });
  if (content !== undefined && !content.trim()) return res.status(400).json({ error: '내용을 입력해주세요' });
  if (content !== undefined && content.trim().length > 10000) return res.status(400).json({ error: '내용은 10000자를 넘을 수 없습니다' });
  await knex('notices').where({ id: req.params.id }).update({
    title: title !== undefined ? title.trim() : existing.title,
    content: content !== undefined ? content.trim() : existing.content,
    is_active: is_active !== undefined ? !!is_active : existing.is_active,
  });
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireRole(...HQ_ROLES), async (req, res) => {
  await knex('notices').where({ id: req.params.id, brand_id: req.user.brand_id }).delete();
  res.json({ ok: true });
});

// 가맹점: 자기 매장에 해당하는(전체공지 또는 자기 매장 지정 공지) 활성 공지만, 본인이 읽었는지 여부와 함께 조회
router.get('/mine', requireAuth, async (req, res) => {
  if (isStoreRole(req.user.role) && !req.user.store_id) return res.json([]);
  const storeId = isStoreRole(req.user.role) ? req.user.store_id : req.query.store_id;
  if (!storeId) return res.json([]);

  const notices = await knex('notices')
    .where({ brand_id: req.user.brand_id, is_active: true })
    .where(function () { this.whereNull('store_id').orWhere('store_id', storeId); })
    .orderBy('created_at', 'desc')
    .limit(20);

  const reads = await knex('notice_reads')
    .where({ user_id: req.user.id })
    .whereIn('notice_id', notices.map(n => n.id));
  const readSet = new Set(reads.map(r => r.notice_id));

  res.json(notices.map(n => ({ ...n, is_read: readSet.has(n.id) })));
});

router.post('/:id/read', requireAuth, async (req, res) => {
  const notice = await knex('notices').where({ id: req.params.id, brand_id: req.user.brand_id }).first();
  if (!notice) return res.status(404).json({ error: '없음' });
  await knex('notice_reads')
    .insert({ notice_id: notice.id, user_id: req.user.id, store_id: req.user.store_id || null })
    .onConflict(['notice_id', 'user_id']).ignore();
  res.json({ ok: true });
});

module.exports = router;
