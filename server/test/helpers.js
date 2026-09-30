'use strict';

// 테스트 공용 헬퍼: 임시 DB 준비, express 앱 구성(index.js와 동일한 라우터 마운트 순서), 픽스처 생성,
// 토큰 발급, 웹훅 서명 생성을 한 곳에 모은다.
//
// 안전장치: DATABASE_FILE이 설정되지 않은 채로 이 파일이 require되면, knexfile.js가
// server/data.db(실제 개발 DB)로 폴백해버려 테스트가 개발 DB를 오염시킬 수 있다.
// 각 테스트 파일은 반드시 이 파일을 require하기 *전에* process.env.DATABASE_FILE을
// 자기만의 임시 경로로 설정해야 한다 (파일마다 달라야 `node --test`의 파일별 병렬 실행에서 안전함).
// 가드를 '!DATABASE_FILE && !DATABASE_URL'로 완화했더니, 셸에 스테이징 DATABASE_URL이 남아 있는
// 상태에서 npm test를 치면 스테이징 DB에 그대로 붙어 migrations.test.js가 마이그레이션을 전부
// down시켜 실데이터 컬럼을 드롭했다. Postgres는 명시적 opt-in 없이는 절대 허용하지 않는다.
const usePg = !!process.env.DATABASE_URL;
if (usePg && process.env.POSMOS_TEST_PG !== '1') {
  throw new Error(
    '[test/helpers.js] DATABASE_URL이 설정된 채로 테스트를 실행하려 했습니다. ' +
    '실수로 개발/스테이징 DB의 마이그레이션을 down시키는 사고를 막기 위한 가드입니다. ' +
    'Postgres로 테스트하려면 POSMOS_TEST_PG=1을 함께 설정하세요(CI의 server-test-postgres 잡이 그렇게 합니다). ' +
    'sqlite로 돌리려면 셸에서 DATABASE_URL을 지우세요.'
  );
}
if (!usePg && !process.env.DATABASE_FILE) {
  throw new Error(
    '[test/helpers.js] DATABASE_FILE 환경변수가 설정되지 않았습니다. ' +
    '테스트가 server/data.db(개발 DB)를 건드리는 사고를 막기 위한 가드입니다. ' +
    "각 테스트 파일 맨 위, require('./helpers')보다 먼저 " +
    'process.env.DATABASE_FILE = <고유한 임시 파일 경로> 를 설정하세요. ' +
    'Postgres로 돌릴 때는 DATABASE_FILE 대신 DATABASE_URL로 대체된다.'
  );
}
// server/src/middleware/auth.js는 JWT_SECRET이 없으면 require 시점에 throw한다 — 테스트에서도 필요.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';
}

const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const { knex, initDb } = require('../src/db/schema');
const { signToken } = require('../src/middleware/auth');

function uniqueSuffix() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// server/src/index.js가 라우터를 마운트하는 순서를 그대로 재현한다. 특히 웹훅 경로에
// express.raw()를 express.json()보다 먼저 등록하는 순서가 중요하다 — 반대로 하면 express.json()이
// 바디를 먼저 다 읽어버려서 웹훅 서명 검증(HMAC)이 항상 빈 바디로 계산되어 전부 실패한다.
function createApp() {
  const app = express();

  app.use('/api/orders/toss-webhook', express.raw({ type: 'application/json' }));
  app.use('/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());

  app.use('/auth', require('../src/routes/auth'));
  app.use('/api', require('../src/routes/api'));
  app.use('/api/orders', require('../src/routes/orders'));
  app.use('/api/products', require('../src/routes/products'));
  app.use('/api/waste', require('../src/routes/waste'));
  app.use('/api/risks', require('../src/routes/risks').router);
  app.use('/api/notices', require('../src/routes/notices'));
  app.use('/api/stock', require('../src/routes/stock'));
  app.use('/api/order-templates', require('../src/routes/orderTemplates'));
  app.use('/webhook', require('../src/routes/webhook'));
  app.use('/sse', require('../src/routes/sse').router);

  // index.js의 전역 에러 핸들러와 동일
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다' });
  });

  return app;
}

// 임의 포트로 실제 HTTP 서버를 띄운다 (내부 함수를 직접 호출하지 않고 실제 요청 경로를 검증하기 위함).
async function startServer(app) {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    // SSE처럼 오래 열려있는 커넥션이 남아있어도 close()가 매달리지 않도록 강제로 소켓을 끊는다.
    close: () => new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function createBrand(overrides = {}) {
  const [row] = await knex('brands').insert({
    name: '테스트브랜드',
    code: `brand_${uniqueSuffix()}`,
    ...overrides,
  }).returning('id');
  return row.id ?? row;
}

async function createStore(brand_id, overrides = {}) {
  const [row] = await knex('stores').insert({
    brand_id,
    name: '테스트가맹점',
    webhook_secret: `whsec_${uniqueSuffix()}`,
    ...overrides,
  }).returning('id');
  return row.id ?? row;
}

async function createUser({ brand_id, store_id = null, role = 'STORE_OWNER', email, password = 'password123!', is_active = true, name = '테스트유저' }) {
  // 실제 운영 코드는 salt rounds 10을 쓰지만, 테스트에서는 속도를 위해 낮춘다 (보안 목적이 아니라 순수 테스트용 계정).
  const password_hash = bcrypt.hashSync(password, 4);
  const resolvedEmail = email || `user_${uniqueSuffix()}@test.local`;
  const [row] = await knex('users').insert({
    brand_id, store_id, email: resolvedEmail, password_hash, name, role, is_active,
  }).returning('id');
  return { id: row.id ?? row, brand_id, store_id, role, email: resolvedEmail, password, is_active };
}

function tokenFor(user) {
  return signToken({ id: user.id, role: user.role, brand_id: user.brand_id, store_id: user.store_id });
}

async function createIngredient(brand_id, store_id, overrides = {}) {
  const [row] = await knex('ingredients').insert({
    brand_id, store_id, name: `재료_${uniqueSuffix()}`, unit: 'g', stock: 1000, threshold: 100,
    ...overrides,
  }).returning('id');
  return row.id ?? row;
}

async function createMenu(brand_id, store_id, overrides = {}) {
  const [row] = await knex('menus').insert({
    brand_id, store_id, name: `메뉴_${uniqueSuffix()}`, is_active: true,
    ...overrides,
  }).returning('id');
  return row.id ?? row;
}

async function createRecipe(menu_id, ingredient_id, amount) {
  await knex('recipes').insert({ menu_id, ingredient_id, amount });
}

// webhook.js와 동일한 방식으로 서명 헤더를 계산 (v1=hmac_sha256(secret, `${timestamp}.${rawBody}`))
function signWebhookHeaders(secret, rawBody, { timestamp } = {}) {
  const ts = timestamp || Math.floor(Date.now() / 1000).toString();
  const hmac = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return { 'x-toss-signature': `v1=${hmac}`, 'x-toss-timestamp': ts };
}

async function teardown() {
  await knex.destroy();
  if (!process.env.DATABASE_URL) {
    // sqlite일 때만 파일을 지운다 — pg 잡은 파일이 아니라 서비스 컨테이너의 DB이므로 지울 파일이 없다.
    const file = process.env.DATABASE_FILE;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(file + suffix); } catch { /* 없으면 무시 */ }
    }
  }
}

// pg 잡에서는 여러 테스트 파일(node --test가 파일마다 별도 프로세스로 실행)이 같은 DB에
// 동시에 initDb()를 돌려 knex 마이그레이션 락(knex_migrations_lock)이 경합할 수 있다. sqlite는
// 파일마다 별도 DB라 이 문제가 없지만, pg는 실패 시 무의미하게 테스트 전체가 죽으므로 짧게
// 재시도한다.
async function initDbForTest() {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await initDb();
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastErr;
}

module.exports = {
  knex,
  initDb: initDbForTest,
  createApp,
  startServer,
  createBrand,
  createStore,
  createUser,
  tokenFor,
  createIngredient,
  createMenu,
  createRecipe,
  signWebhookHeaders,
  teardown,
};
