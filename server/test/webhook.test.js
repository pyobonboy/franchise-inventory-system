'use strict';

const path = require('node:path');
const os = require('node:os');

// helpers.js를 require하기 전에 이 파일 전용 임시 DB 경로를 지정 (server/data.db를 건드리지 않기 위함).
process.env.DATABASE_FILE = path.join(os.tmpdir(), `posmos-test-webhook-${process.pid}-${Date.now()}.db`);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
// 전역 폴백 시크릿이 "시크릿 없는 가맹점" 테스트에 영향을 주지 않도록 명시적으로 비운다.
delete process.env.TOSS_WEBHOOK_SECRET;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  initDb, createApp, startServer, teardown,
  createBrand, createStore, signWebhookHeaders,
} = require('./helpers');

let ctx;
let brandId;
let storeId;
const SECRET = 'whsec_test_fixed_secret';

before(async () => {
  await initDb();
  const app = createApp();
  ctx = await startServer(app);
  brandId = await createBrand();
  storeId = await createStore(brandId, { webhook_secret: SECRET });
});

after(async () => {
  await ctx.close();
  await teardown();
});

async function postWebhook(idOrName, headers, rawBody) {
  return fetch(`${ctx.baseUrl}/webhook/${encodeURIComponent(idOrName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
}

test('서명 헤더가 없는 웹훅은 401로 거부된다', async () => {
  const rawBody = JSON.stringify({ type: 'ping' });
  const res = await postWebhook(storeId, {}, rawBody);
  assert.equal(res.status, 401);
});

test('잘못된 서명의 웹훅은 401로 거부된다', async () => {
  const rawBody = JSON.stringify({ type: 'ping' });
  const res = await postWebhook(storeId, {
    'x-toss-signature': 'v1=' + '0'.repeat(64),
    'x-toss-timestamp': Math.floor(Date.now() / 1000).toString(),
  }, rawBody);
  assert.equal(res.status, 401);
});

test('타임스탬프가 5분 넘게 차이나면 401로 거부된다 (재전송 공격 방지)', async () => {
  const rawBody = JSON.stringify({ type: 'ping' });
  const oldTs = Math.floor((Date.now() - 6 * 60 * 1000) / 1000).toString();
  const headers = signWebhookHeaders(SECRET, rawBody, { timestamp: oldTs });
  const res = await postWebhook(storeId, headers, rawBody);
  assert.equal(res.status, 401);
});

test('시크릿이 없는 가맹점의 웹훅은 401로 거부된다', async () => {
  const noSecretStoreId = await createStore(brandId, { webhook_secret: '', name: '시크릿없는가맹점' });
  const rawBody = JSON.stringify({ type: 'ping' });
  // 시크릿이 없는 가맹점이라도 요청 측은 아무 값으로나 서명해서 보낼 수 있다 — 서버가 진짜로
  // "시크릿 부재" 자체를 거부 사유로 삼는지 확인하는 것이 목적이므로 서명 성공 여부는 무관하다.
  const headers = signWebhookHeaders('아무-비밀값', rawBody);
  const res = await postWebhook(noSecretStoreId, headers, rawBody);
  assert.equal(res.status, 401);
});

test('/webhook/:storeId에 가맹점 이름을 넣으면 404 (숫자 ID만 허용)', async () => {
  const res = await postWebhook('테스트가맹점', {}, '{}');
  assert.equal(res.status, 404);
});

test('존재하지 않는 가맹점 ID면 404', async () => {
  const res = await postWebhook(999999, {}, '{}');
  assert.equal(res.status, 404);
});

test('올바른 서명의 웹훅은 200을 응답한다', async () => {
  // type이 order.order.* 접두사가 아니므로 서명 검증만 통과하면 바로 200 (재고/주문 처리 로직 이전에 반환됨)
  const rawBody = JSON.stringify({ type: 'some.other.event' });
  const headers = signWebhookHeaders(SECRET, rawBody);
  const res = await postWebhook(storeId, headers, rawBody);
  assert.equal(res.status, 200);
});
