'use strict';

const path = require('node:path');
const os = require('node:os');

process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-sse-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  initDb, createApp, startServer, teardown,
  createBrand, createStore, createUser, tokenFor,
} = require('./helpers');

let ctx;
let brandId;
let store1Id;
let store2Id;
let broadcast;
const openConnections = [];

before(async () => {
  await initDb();
  const app = createApp();
  // sse.js는 require 캐시로 싱글턴이므로, createApp()이 마운트한 라우터와 여기서 다시 require하는
  // broadcast는 같은 clients Map을 공유한다 — 그래서 테스트에서 실제 webhook/index.js가 하듯
  // broadcast()를 직접 호출해 이벤트를 흘려보낼 수 있다.
  broadcast = require('../src/routes/sse').broadcast;
  ctx = await startServer(app);
  brandId = await createBrand();
  store1Id = await createStore(brandId, { name: '가맹점1' });
  store2Id = await createStore(brandId, { name: '가맹점2' });
});

after(async () => {
  for (const controller of openConnections) {
    try { controller.abort(); } catch { /* 이미 끝난 연결은 무시 */ }
  }
  await ctx.close();
  await teardown();
});

async function openSse(token) {
  const controller = new AbortController();
  openConnections.push(controller);
  const res = await fetch(`${ctx.baseUrl}/sse?token=${encodeURIComponent(token)}`, { signal: controller.signal });
  return { res, controller };
}

// SSE 스트림에서 다음 "data: ...\n\n" 이벤트 한 건을 읽어 파싱한다.
async function readNextEvent(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('스트림이 이벤트를 받기 전에 종료되었습니다');
    buffer += decoder.decode(value, { stream: true });
    const idx = buffer.indexOf('\n\n');
    if (idx !== -1) {
      const chunk = buffer.slice(0, idx);
      reader.releaseLock();
      return JSON.parse(chunk.replace(/^data: /, ''));
    }
  }
}

test('본사 계정은 자기 브랜드 이벤트만 수신한다', async () => {
  const hqUser = await createUser({ brand_id: brandId, role: 'HQ_ADMIN' });
  const { res, controller } = await openSse(tokenFor(hqUser));
  assert.equal(res.status, 200);

  const otherBrandId = await createBrand({ name: '다른브랜드' });
  // 다른 브랜드 이벤트를 먼저 보내고, 이어서 내 브랜드 이벤트를 보낸다. SSE는 순서가 보장되는
  // 스트림이므로, 다음에 읽히는 이벤트가 "내 브랜드" 것이라면 앞의 "다른 브랜드" 이벤트는
  // 애초에 이 커넥션에 쓰여지지 않았다는 뜻이다 (필터링이 실제로 동작했다는 증거).
  broadcast({ type: 'TEST', brandId: otherBrandId, storeId: store1Id });
  broadcast({ type: 'TEST', brandId, storeId: store1Id });

  const event = await readNextEvent(res);
  assert.equal(event.brandId, brandId);
  controller.abort();
});

test('가맹점 계정은 자기 가맹점 이벤트만 수신한다', async () => {
  const storeUser = await createUser({ brand_id: brandId, store_id: store1Id, role: 'STORE_OWNER' });
  const { res, controller } = await openSse(tokenFor(storeUser));
  assert.equal(res.status, 200);

  broadcast({ type: 'TEST', brandId, storeId: store2Id }); // 다른 가맹점 — 못 받아야 함
  broadcast({ type: 'TEST', brandId, storeId: store1Id }); // 내 가맹점 — 받아야 함

  const event = await readNextEvent(res);
  assert.equal(event.storeId, store1Id);
  controller.abort();
});

test('본사 계정은 특정 가맹점 필터와 무관하게 브랜드 전체 이벤트를 받는다', async () => {
  const hqUser = await createUser({ brand_id: brandId, role: 'HQ_LOGISTICS' });
  const { res, controller } = await openSse(tokenFor(hqUser));
  assert.equal(res.status, 200);

  // 가맹점 역할이라면 못 받았을 storeId(가맹점2)의 이벤트도 본사는 brandId만 맞으면 받아야 한다
  broadcast({ type: 'TEST', brandId, storeId: store2Id });
  const event = await readNextEvent(res);
  assert.equal(event.storeId, store2Id);
  assert.equal(event.brandId, brandId);
  controller.abort();
});

test('비활성 계정은 SSE 연결이 거부된다', async () => {
  const inactiveUser = await createUser({ brand_id: brandId, store_id: store1Id, role: 'STORE_OWNER', is_active: false });
  const res = await fetch(`${ctx.baseUrl}/sse?token=${encodeURIComponent(tokenFor(inactiveUser))}`);
  assert.equal(res.status, 401);
});

test('유효하지 않은 토큰은 SSE 연결이 거부된다', async () => {
  const res = await fetch(`${ctx.baseUrl}/sse?token=not-a-real-jwt`);
  assert.equal(res.status, 401);
});
