'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-syncwindow-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { knex, initDb, teardown, createBrand, createStore } = require('./helpers');
const { acquireStoreSyncLock, releaseStoreSyncLock } = require('../src/syncLock');
const toss = require('../src/channels/toss');
const {
  computeSyncWindow,
  computeFailureOutcome,
  SYNC_OVERLAP_MS,
  SYNC_MIN_WINDOW_MS,
  SYNC_INITIAL_MS,
} = require('../src/syncWindow');

let brandId;
const originalFetch = global.fetch;
// syncStoreSales 테스트가 이 값들을 채워 넣는데, 프로세스가 파일마다 분리되긴 하지만
// test:serial(단일 프로세스 아님)이나 로컬에서 단일 파일로 돌릴 때 다른 테스트에 새는 것을 막는다.
const originalTossEnv = { access: process.env.TOSS_PLACE_ACCESS_KEY, secret: process.env.TOSS_PLACE_SECRET_KEY };

before(async () => {
  await initDb();
  brandId = await createBrand();
});

after(async () => {
  global.fetch = originalFetch;
  if (originalTossEnv.access === undefined) delete process.env.TOSS_PLACE_ACCESS_KEY;
  else process.env.TOSS_PLACE_ACCESS_KEY = originalTossEnv.access;
  if (originalTossEnv.secret === undefined) delete process.env.TOSS_PLACE_SECRET_KEY;
  else process.env.TOSS_PLACE_SECRET_KEY = originalTossEnv.secret;
  await teardown();
});

afterEach(() => { global.fetch = originalFetch; });

test('kstDayStartTs/kstDayEndTs가 KST(UTC+9) 오프셋으로 정확한 epoch ms를 반환한다', () => {
  const start = toss.kstDayStartTs('2026-01-01');
  const end = toss.kstDayEndTs('2026-01-01');
  // KST 2026-01-01 00:00:00 = UTC 2025-12-31 15:00:00
  assert.equal(start, Date.parse('2025-12-31T15:00:00.000Z'));
  // KST 2026-01-01 23:59:59.999 = UTC 2026-01-01 14:59:59.999
  assert.equal(end, Date.parse('2026-01-01T14:59:59.999Z'));
  assert.ok(end > start);
});

test('acquireStoreSyncLock: 같은 매장에 2회 시도하면 두 번째는 실패하고, 올바른 stamp로 해제한 뒤에는 재획득할 수 있다', async () => {
  const storeId = await createStore(brandId);

  const first = await acquireStoreSyncLock(knex, storeId);
  assert.equal(first.ok, true);
  assert.ok(first.stamp);

  const second = await acquireStoreSyncLock(knex, storeId);
  assert.equal(second.ok, false);
  assert.equal(second.stamp, null);

  // 잘못된 stamp로 해제를 시도하면 잠금이 그대로 유지되어야 한다(TTL 만료 후 다른 실행이 이미 가져간 것과 혼동 방지)
  await releaseStoreSyncLock(knex, storeId, 'wrong-stamp-value');
  const stillLocked = await acquireStoreSyncLock(knex, storeId);
  assert.equal(stillLocked.ok, false, '잘못된 stamp로는 해제되지 않아야 한다');

  // 올바른 stamp로 해제하면 다시 획득할 수 있어야 한다
  await releaseStoreSyncLock(knex, storeId, first.stamp);
  const third = await acquireStoreSyncLock(knex, storeId);
  assert.equal(third.ok, true, '올바른 stamp로 해제한 뒤에는 다시 획득할 수 있어야 한다');
});

test('syncStoreSales: 주문 3건 중 1건이 예외를 던지면 {inserted:2, failed:1}을 반환한다', async () => {
  const storeId = await createStore(brandId, { toss_store_id: `toss_place_${Date.now()}` });
  process.env.TOSS_PLACE_ACCESS_KEY = 'dummy_access_key';
  process.env.TOSS_PLACE_SECRET_KEY = 'dummy_secret_key';

  const order1 = { id: 'sw_order_1', createdAt: new Date().toISOString(), orderState: 'COMPLETED', source: 'POS', lineItems: [{ name: '동기화메뉴A', quantity: 1 }] };
  const order2 = { id: 'sw_order_2', createdAt: new Date().toISOString(), orderState: 'COMPLETED', source: 'POS', lineItems: [{ name: '동기화메뉴B', quantity: 1 }] };
  const order3 = { id: 'sw_order_3', createdAt: new Date().toISOString(), orderState: 'COMPLETED', source: 'POS', lineItems: [{ name: '동기화메뉴C', quantity: 1 }] };
  // JSON.stringify 시 순환 참조 예외를 강제로 일으켜, ingestCompletedOrder 내부에서 raw_payload를
  // 직렬화하다가 실패하는 "주문 한 건 처리 실패" 상황을 재현한다.
  order3.selfRef = order3;

  global.fetch = async (url) => {
    if (String(url).includes('/order/orders')) {
      return { ok: true, status: 200, json: async () => ({ success: [order1, order2, order3] }) };
    }
    return originalFetch(url);
  };

  const store = await knex('stores').where({ id: storeId }).first();
  const now = Date.now();
  const result = await toss.syncStoreSales(store, now - 86400000, now);

  assert.equal(result.inserted, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.total, 3);
});

test('computeSyncWindow: 최초(null)는 5년, 이후는 min(last-10분, now-2일)', () => {
  const now = Date.now();

  // 최초 동기화(한 번도 동기화 안 한 가맹점)는 5년 전부터 훑는다.
  const initial = computeSyncWindow(null, now);
  assert.equal(initial.fromTs, now - SYNC_INITIAL_MS);
  assert.equal(initial.toTs, now);
  assert.equal(initial.lastTs, null);

  // 30분 전 동기화: lastTs-10분(now-40분)보다 now-2일이 더 과거이므로 2일 창이 이긴다.
  const last30MinAgo = new Date(now - 30 * 60 * 1000).toISOString();
  const recent = computeSyncWindow(last30MinAgo, now);
  assert.equal(recent.fromTs, now - SYNC_MIN_WINDOW_MS);

  // 5일 전 동기화: lastTs-10분(now-5일-10분)이 now-2일보다 더 과거이므로 lastTs 쪽이 이긴다.
  const last5DaysAgo = now - 5 * 86400000;
  const old = computeSyncWindow(new Date(last5DaysAgo).toISOString(), now);
  assert.equal(old.fromTs, last5DaysAgo - SYNC_OVERLAP_MS);
});

test('computeFailureOutcome: 재시도 창이 앞으로 밀리는 경우에만 advanced=true', () => {
  const now = Date.now();

  // 1일 전 동기화: retryFloor(now-2일)가 lastTs(now-1일)보다 과거라 창이 밀리지 않는다.
  const lastOneDayAgo = now - 86400000;
  const notAdvanced = computeFailureOutcome(lastOneDayAgo, now);
  assert.equal(notAdvanced.advanced, false);

  // 5일 전 동기화: retryFloor(now-2일)가 lastTs(now-5일)보다 미래라 창이 앞으로 밀린다.
  const lastFiveDaysAgo = now - 5 * 86400000;
  const advanced = computeFailureOutcome(lastFiveDaysAgo, now);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.retryFloorTs, now - SYNC_MIN_WINDOW_MS);

  // 최초 동기화(lastTs=null)는 무조건 창이 밀린 것으로 취급한다.
  const neverSynced = computeFailureOutcome(null, now);
  assert.equal(neverSynced.advanced, true);
  // `advanced=true`일 때 `index.js`가 연속 실패 횟수와 무관하게 `SYNC_FAILED`를 만든다는 부분은
  // 크론 루프가 export되지 않아 여기서 직접 검증하지 못한다 — 이 함수의 판정만 고정한다.
});
