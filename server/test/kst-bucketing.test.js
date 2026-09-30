'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-kstbucketing-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  knex, initDb, createApp, startServer, teardown,
  createBrand, createStore, createUser, tokenFor,
} = require('./helpers');
const { kstDayRange } = require('../src/dbTime');

let ctx;
let brandId;
let storeId;

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeId = await createStore(brandId);
});

after(async () => {
  await ctx.close();
  await teardown();
});

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

test('GET /api/analytics: 일별 매출 버킷이 KST 자정 경계로 나뉜다', async () => {
  // 이 테스트가 pg 잡에서 `AT TIME ZONE 'Asia/Seoul'` 표현식(api.js의 dateExpr)의 정확성을
  // 검증하는 유일한 지점이다 — sqlite 쪽 strftime 분기만 통과하고 pg 분기가 깨져도 sqlite 잡은
  // 계속 초록불이라, CI에 pg 잡(server-test-postgres)이 반드시 함께 돌아야 이 경계 버그를 잡는다.
  const owner = await createUser({ brand_id: brandId, store_id: storeId, role: 'STORE_OWNER' });
  const ownerToken = tokenFor(owner);

  await knex('sales_items').insert({
    brand_id: brandId, store_id: storeId, toss_order_id: `order_kst_late_${Date.now()}`,
    menu_name: '메뉴A', quantity: 1, unit_price: 1000, amount: 1000,
    sold_at: '2026-03-01T14:00:00.000Z', // KST 2026-03-01 23:00
  });
  await knex('sales_items').insert({
    brand_id: brandId, store_id: storeId, toss_order_id: `order_kst_early_${Date.now()}`,
    menu_name: '메뉴A', quantity: 1, unit_price: 2000, amount: 2000,
    sold_at: '2026-03-01T16:00:00.000Z', // KST 2026-03-02 01:00
  });

  const res = await fetch(`${ctx.baseUrl}/api/analytics?from=2026-02-28&to=2026-03-03`, { headers: authHeader(ownerToken) });
  assert.equal(res.status, 200);
  const body = await res.json();

  const day1 = body.dailyRevenue.find(r => r.date === '2026-03-01');
  const day2 = body.dailyRevenue.find(r => r.date === '2026-03-02');
  assert.ok(day1, 'KST 3/1 23:00 판매는 2026-03-01 버킷에 잡혀야 한다');
  assert.equal(Number(day1.revenue), 1000);
  assert.ok(day2, 'KST 3/2 01:00 판매는 2026-03-02 버킷에 잡혀야 한다(UTC로만 자르면 여전히 3/1로 묶인다)');
  assert.equal(Number(day2.revenue), 2000);
});

test("GET /api/stores/order-status: '오늘 발주' 판정이 KST 자정 기준이다", async () => {
  const hq = await createUser({ brand_id: brandId, role: 'HQ_ADMIN' });
  const hqToken = tokenFor(hq);

  // 마감시각(order_deadline)은 판정 시각(diffMin) 필터에만 관여하므로, 테스트 실행 시각과 무관하게
  // 항상 "마감 2시간 이내" 조건을 만족하도록 현재 KST 시각 + 1시간으로 동적으로 잡는다.
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 3600000);
  let hh = kstNow.getUTCHours();
  let mm = kstNow.getUTCMinutes() + 60;
  if (mm >= 60) { mm -= 60; hh += 1; }
  hh = hh % 24;
  const orderDeadline = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

  const targetStoreId = await createStore(brandId, { name: 'KST경계매장', is_open: true, order_deadline: orderDeadline, delivery_days: null });

  // KST 오늘 새벽(예: 00:30)에 해당하는 시각 = UTC로는 어제 오후. dbTime.kstDayRange(new Date())의
  // startIso가 "KST 오늘 00:00"의 UTC 표현이므로, 여기서 30분을 더해 만든다.
  const { startIso } = kstDayRange(new Date());
  const earlyKstTodayIso = new Date(new Date(startIso).getTime() + 30 * 60000).toISOString();

  await knex('purchase_orders').insert({
    brand_id: brandId, store_id: targetStoreId, status: 'ORDERED', total_amount: 1000,
    created_at: earlyKstTodayIso,
  });

  // 대조군: 같은 조건이지만 발주 기록이 없는 매장 — order-status가 뭔가 잘못돼 전체를 걸러내는게
  // 아니라 실제로 "오늘 발주 여부"로 갈리는지 확인한다.
  const controlStoreId = await createStore(brandId, { name: 'KST경계대조매장', is_open: true, order_deadline: orderDeadline, delivery_days: null });

  const res = await fetch(`${ctx.baseUrl}/api/stores/order-status`, { headers: authHeader(hqToken) });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(!body.some(r => r.store_id === targetStoreId), 'KST 오늘 새벽에 발주한 매장은 미발주 목록에서 빠져야 한다');
  assert.ok(body.some(r => r.store_id === controlStoreId), '발주 기록이 없는 대조군 매장은 미발주 목록에 남아야 한다');
});
