'use strict';

/**
 * 배포 전(또는 배포 직후) 사전 점검 도구.
 *
 * 왜 필요한가: 이 시스템은 아직 실제 운영 환경에서 돌아본 적이 없다. 배포 첫날 조용히 깨질 수 있는
 * 지점(SSL 미적용, 가맹점 webhook_secret 누락으로 인한 매출 유입 차단, 레시피 미지정 메뉴 등)은
 * 대부분 증상이 늦게 나타난다 — 화면은 멀쩡한데 뒤에서 데이터가 조용히 틀어지는 식이다. 이 스크립트는
 * 그런 지점을 한 번에 찾아 배포 직후(그리고 이후 반복적으로) 점검할 수 있게 한다.
 *
 * 절대 원칙: 읽기 전용이다. 운영 DB에 대고 반복 실행할 도구이므로 어떤 테이블도 쓰거나 고치지 않는다.
 * - initDb()를 호출하지 않는다 — initDb()는 매 실행마다 스키마를 재확인/보정하고(addColumnIfMissing 등),
 *   로컬에서는 STORE_OWNER/STORE_STAFF 비밀번호를 admin123으로 되돌리는 부작용까지 있다(schema.js 참고).
 *   knexfile.js와 db/schema.js가 export하는 knex 인스턴스만 그대로 재사용해 커넥션 설정만 가져온다.
 * - knex.migrate.list()/latest()도 쓰지 않는다 — list()조차 내부적으로 knex_migrations/
 *   knex_migrations_lock 테이블이 없으면 생성한다(node_modules/knex/lib/migrations/migrate/
 *   table-creator.js의 ensureTable, 실제로 열어서 확인함). 정상적으로 한 번이라도 기동된 DB라면
 *   두 테이블이 이미 있어 이 경로가 쓰기로 이어지지 않지만, "완전한 신규 DB"라는 예외 상황까지
 *   보장하기 위해 knex_migrations 테이블 존재 여부를 hasTable()로만 확인하고, 있으면 select로 목록만
 *   읽어 마이그레이션 디렉터리 파일 목록과 직접 비교한다.
 *
 * 토스 API를 실제로 호출하지 않는 이유: 키가 유효한지 확인하려면 결국 진짜 매출 조회 요청을 날려야
 * 하는데, 이 스크립트는 운영 DB에 대고 몇 번이고 안전하게 반복 실행할 수 있어야 한다는 요구사항과
 * 충돌한다. 게다가 토스플레이스 동기화(server/src/channels/toss.js)는 실패 시 SYNC_FAILED 리스크로
 * 이어지는 별도 크론이 이미 있으므로, 여기서는 "호출이 가능한 상태인지"(키 존재 여부, DB에 반영된
 * 연동 대상 가맹점 수)까지만 정적으로 점검한다.
 *
 * 실행: server 디렉터리에서 `npm run preflight` (또는 `node scripts/preflight.js`).
 * 종료 코드: 치명(FATAL) 항목이 하나라도 있으면 1, 없으면 0 — CI/배포 스크립트에서 게이트로 쓸 수 있다.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');

const { knex, isProduction } = require('../src/db/schema');
const { isEncrypted, hasKey } = require('../src/crypto');
const { RISK_TYPES, RISK_STATUSES } = require('../src/constants');

// 시스템 신호성 리스크 타입 — CLAUDE.md 2절: "장사 리스크"가 아니라 시스템이 제 역할을 못 하고 있다는 신호.
const SYSTEM_SIGNAL_RISK_TYPES = new Set([
  RISK_TYPES.MENU_UNMATCHED,
  RISK_TYPES.NEGATIVE_STOCK,
  RISK_TYPES.WEBHOOK_REJECTED,
  RISK_TYPES.SYNC_FAILED,
]);

const LEVEL = { FATAL: '치명', WARN: '경고', INFO: '정보' };
const results = []; // { level, check, message }

function report(level, check, message) {
  results.push({ level, check, message });
}

// ── 1. DB 연결 ──────────────────────────────────────────────────────────
async function checkDbConnection() {
  const client = isProduction ? 'pg (Postgres)' : 'sqlite3';
  try {
    const DB_TIMEOUT_MS = 5000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DB 연결 확인이 타임아웃되었습니다')), DB_TIMEOUT_MS);
    });
    await Promise.race([knex.raw('select 1'), timeout]);
    clearTimeout(timer);
    const sslNote = isProduction
      ? (String(process.env.DATABASE_SSL || '').toLowerCase() === 'disable' ? ', SSL 비활성(DATABASE_SSL=disable)' : ', SSL 사용')
      : '';
    report('INFO', 'DB 연결', `정상 연결됨 (${client}${sslNote})`);
  } catch (e) {
    // knexfile.js: SSL 설정은 반드시 connection 객체 안에 있어야 인식된다. 이번 배포에서 처음 실제로
    // 적용되는 부분이라, 연결 실패 시 SSL 관련 원인부터 짐작할 수 있게 메시지를 덧붙인다.
    const hint = isProduction
      ? ' (DATABASE_URL 값 확인, Postgres가 SSL을 요구/거부하는지 확인 — knexfile.js는 ssl.rejectUnauthorized=false로 접속을 시도한다)'
      : ' (server/data.db 파일 권한 또는 DATABASE_FILE 경로 확인)';
    report('FATAL', 'DB 연결', `연결 실패: ${e.message}${hint}`);
    return false;
  }
  return true;
}

// ── 2. 마이그레이션 상태 ─────────────────────────────────────────────────
async function checkMigrations() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const localFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  const hasTable = await knex.schema.hasTable('knex_migrations');
  if (!hasTable) {
    // knex_migrations 테이블 자체가 없다 = 이 DB에서 knex.migrate.latest()가 단 한 번도 성공적으로
    // 돈 적이 없다는 뜻 (initDb()가 서버 기동 마지막에 항상 호출하므로, 서버가 한 번도 안 떴거나
    // 매번 initDb() 도중에 죽고 있다는 신호일 수 있다).
    report('FATAL', '마이그레이션 상태',
      `knex_migrations 테이블이 없습니다 — 이 DB에서 마이그레이션이 한 번도 적용되지 않았습니다. ` +
      `서버를 최소 한 번 정상 기동시켜 initDb()가 knex.migrate.latest()까지 끝마치게 해야 합니다.`);
    return;
  }

  const applied = new Set((await knex('knex_migrations').select('name')).map(r => r.name));
  const pending = localFiles.filter(f => !applied.has(f));

  if (pending.length > 0) {
    // 서버가 기동되면 initDb()가 매번 knex.migrate.latest()를 호출해 자동으로 적용하므로 이 자체가
    // 서비스 중단으로 이어지진 않는다. 다만 "적용 안 된 채로 배포됨"은 배포 순서(마이그레이션 파일이
    // 아직 반영 안 된 옛 코드가 떠 있거나, 서버가 계속 기동에 실패해 initDb()가 못 끝나는 상황)를
    // 의심할 신호라 경고로 남긴다.
    report('WARN', '마이그레이션 상태',
      `미적용 마이그레이션 ${pending.length}건: ${pending.join(', ')} — 서버 기동 시 initDb()가 자동 적용하지만, ` +
      `아직 적용되지 않았다는 것은 서버가 이 DB를 대상으로 정상 기동한 적이 없거나 기동이 계속 실패 중임을 뜻할 수 있다.`);
  } else {
    report('INFO', '마이그레이션 상태', `모든 마이그레이션 적용됨 (${localFiles.length}건)`);
  }
}

// ── 3. 필수 환경변수 ─────────────────────────────────────────────────────
async function checkEnvVars() {
  // JWT_SECRET 없으면 middleware/auth.js가 require 시점에 즉시 throw한다 — 서버가 아예 못 뜬다.
  if (!process.env.JWT_SECRET) {
    report('FATAL', 'JWT_SECRET', '설정되지 않음 — server/src/middleware/auth.js가 require 시점에 예외를 던져 서버가 시작조차 못 함.');
  } else {
    report('INFO', 'JWT_SECRET', '설정됨');
  }

  // CLIENT_URL: 운영에서만 필수 (index.js). 로컬은 localhost/trycloudflare/onrender 와일드카드로 우회됨.
  if (isProduction) {
    const clientUrl = (process.env.CLIENT_URL || '').trim();
    if (!clientUrl) {
      report('FATAL', 'CLIENT_URL', '운영 환경인데 설정되지 않음 — index.js의 CORS 화이트리스트가 비어 프론트엔드 요청이 전부 차단됨(서버 자체는 뜨지만 브라우저에서 아무 API도 못 부름).');
    } else {
      report('INFO', 'CLIENT_URL', `설정됨 (${clientUrl})`);
    }
  } else {
    report('INFO', 'CLIENT_URL', '로컬 환경이라 필수 아님 (localhost/trycloudflare/onrender 출처는 자동 허용됨)');
  }

  // TOSS_SECRET_KEY: 없으면 결제 승인/취소/환불 라우트(routes/orders.js)가 500을 반환 — 발주 결제
  // 기능 하나가 막히는 것이지 서비스 전체가 죽는 건 아니다.
  if (!process.env.TOSS_SECRET_KEY) {
    report('WARN', 'TOSS_SECRET_KEY', '설정되지 않음 — 발주 결제 승인/취소/환불(routes/orders.js)이 500 오류("결제 설정 오류")를 반환함. 결제 기능만 영향받고 서비스 자체는 정상 동작.');
  } else {
    report('INFO', 'TOSS_SECRET_KEY', '설정됨');
  }

  // TOSS_PLACE_ACCESS_KEY / TOSS_PLACE_SECRET_KEY: 없으면 channels/toss.js의 syncStoreSales가 매번
  // throw한다 — toss_store_id가 설정된 가맹점이 하나라도 있으면 그 가맹점들은 매출이 절대 자동
  // 동기화되지 않고, index.js의 runAutoSync가 5회 연속 실패 후 SYNC_FAILED 리스크를 만든다(약 15분 후).
  const hasPlaceAccess = !!process.env.TOSS_PLACE_ACCESS_KEY;
  const hasPlaceSecret = !!process.env.TOSS_PLACE_SECRET_KEY;
  if (!hasPlaceAccess || !hasPlaceSecret) {
    const missing = [!hasPlaceAccess && 'TOSS_PLACE_ACCESS_KEY', !hasPlaceSecret && 'TOSS_PLACE_SECRET_KEY'].filter(Boolean).join(', ');
    const syncTargetCount = await knex('stores').whereNotNull('toss_store_id').where('toss_store_id', '!=', '').count('id as cnt').first();
    const targetCnt = Number(syncTargetCount.cnt);
    if (targetCnt > 0) {
      report('FATAL', 'TOSS_PLACE_ACCESS_KEY/SECRET_KEY',
        `${missing} 미설정 — 토스플레이스 매장 ID가 등록된 가맹점 ${targetCnt}곳의 자동 매출 동기화가 3분마다 계속 실패함(channels/toss.js가 매번 예외를 던짐). 결국 SYNC_FAILED 리스크로 이어지지만 그 전까지 매출/재고가 조용히 밀림.`);
    } else {
      report('WARN', 'TOSS_PLACE_ACCESS_KEY/SECRET_KEY', `${missing} 미설정 — 현재 toss_store_id가 등록된 가맹점이 없어 당장 영향은 없지만, 가맹점을 추가하기 전에 설정 필요.`);
    }
  } else {
    report('INFO', 'TOSS_PLACE_ACCESS_KEY/SECRET_KEY', '설정됨');
  }

  // CREDENTIALS_KEY: 없으면 자격증명이 평문 저장(crypto.js) — 운영에서 권장되지만 없다고 서비스가
  // 죽거나 기능이 막히진 않는다.
  if (!process.env.CREDENTIALS_KEY) {
    report('WARN', 'CREDENTIALS_KEY', '설정되지 않음 — webhook_secret/toss_client_secret 등 자격증명이 DB에 평문으로 저장됨(DB 덤프 유출 시 그대로 노출). 필수는 아니지만 운영에서는 설정 권장.');
  } else {
    report('INFO', 'CREDENTIALS_KEY', '설정됨');
  }
}

// ── 4. 가맹점별 webhook_secret ───────────────────────────────────────────
async function checkWebhookSecrets() {
  const rows = await knex('stores as s')
    .join('brands as b', 's.brand_id', 'b.id')
    .where(function () { this.whereNull('s.webhook_secret').orWhere('s.webhook_secret', ''); })
    .select('s.id', 's.name as store_name', 'b.name as brand_name');

  if (rows.length === 0) {
    report('INFO', 'webhook_secret', '모든 가맹점에 설정되어 있음');
    return;
  }
  // 시크릿 값 자체는 절대 출력하지 않는다 — 가맹점 이름만 나열.
  const names = rows.map(r => `${r.brand_name}/${r.store_name}(id=${r.id})`).join(', ');
  // 예전엔 재고 차감이 웹훅 경로에만 있어서 시크릿 누락 = 매출 유입 중단(FATAL)이었다.
  // 지금은 폴링(runAutoSync → salesIngest)이 주문 수집·재고 차감·취소 복구를 전부 처리하므로
  // 웹훅은 선택이다 — 시크릿이 없으면 그 가맹점의 웹훅만 거부될 뿐 매출은 폴링으로 들어온다.
  // 실제로 매출 유입을 좌우하는 건 아래 5번의 toss_store_id다.
  report('INFO', 'webhook_secret',
    `webhook_secret이 비어있는 가맹점 ${rows.length}곳: ${names} — 웹훅은 현재 선택 사항이라(매출은 폴링으로 수집됨) 문제는 아니다. 웹훅을 실제로 쓰려는 가맹점이라면 등록 필요.`);
}

// ── 5. 토스플레이스 연동(toss_store_id) ──────────────────────────────────
async function checkTossStoreIds() {
  const rows = await knex('stores as s')
    .join('brands as b', 's.brand_id', 'b.id')
    .where(function () { this.whereNull('s.toss_store_id').orWhere('s.toss_store_id', ''); })
    .select('s.id', 's.name as store_name', 'b.name as brand_name');

  if (rows.length === 0) {
    report('INFO', 'toss_store_id', '모든 가맹점에 설정되어 있음');
    return;
  }
  const names = rows.map(r => `${r.brand_name}/${r.store_name}(id=${r.id})`).join(', ');
  // 폴링이 유일한 매출 수집 경로가 된 뒤로 이게 가장 치명적인 설정 누락이다. runAutoSync가
  // whereNotNull('toss_store_id')로 대상을 고르므로, 비어 있으면 그 가맹점은 동기화 대상에서
  // 아예 빠진다 — 매출도 재고 차감도 사입 감시도 전부 안 돈다. 화면은 멀쩡해 보이는 게 문제다.
  report('FATAL', 'toss_store_id',
    `toss_store_id(토스플레이스 merchantId)가 없는 가맹점 ${rows.length}곳: ${names} — runAutoSync 대상에서 제외되어 매출이 전혀 수집되지 않고, 따라서 재고 차감·사입 감시도 돌지 않는다. 가맹점 등록 시 반드시 입력할 것.`);
}

// ── 6. 자격증명 암호화 상태 ───────────────────────────────────────────────
async function checkCredentialEncryption() {
  if (!hasKey()) {
    // CREDENTIALS_KEY 자체가 없으면 애초에 전부 평문이 "정상" 상태다 — 이건 위 3번 환경변수 체크가 이미 알린다.
    report('INFO', '자격증명 암호화', 'CREDENTIALS_KEY 미설정 — 암호화 대상 아님(3번 환경변수 점검 참고)');
    return;
  }

  const plaintextStores = await knex('stores')
    .where(function () {
      this.whereNotNull('webhook_secret').where('webhook_secret', '!=', '')
        .orWhere(function () { this.whereNotNull('toss_client_secret').where('toss_client_secret', '!=', ''); });
    })
    .select('id', 'name', 'webhook_secret', 'toss_client_secret');

  const stillPlaintext = plaintextStores.filter(s =>
    (s.webhook_secret && !isEncrypted(s.webhook_secret)) || (s.toss_client_secret && !isEncrypted(s.toss_client_secret)));

  const integrationRows = await knex('store_integrations').whereNotNull('credentials').select('id', 'store_id', 'credentials');
  let plaintextIntegrations = 0;
  for (const row of integrationRows) {
    try {
      const parsed = JSON.parse(row.credentials);
      if (parsed && typeof parsed.client_secret === 'string' && parsed.client_secret && !isEncrypted(parsed.client_secret)) {
        plaintextIntegrations++;
      }
    } catch { /* JSON 아니면 credentialsBackfill.js와 동일하게 건너뜀 */ }
  }

  if (stillPlaintext.length === 0 && plaintextIntegrations === 0) {
    report('INFO', '자격증명 암호화', 'CREDENTIALS_KEY 설정됨, 평문으로 남은 자격증명 없음(백필 정상 반영됨)');
  } else {
    report('WARN', '자격증명 암호화',
      `CREDENTIALS_KEY는 설정되어 있으나 평문으로 남은 자격증명이 있음: stores ${stillPlaintext.length}건(id: ${stillPlaintext.map(s => s.id).join(', ')}), store_integrations ${plaintextIntegrations}건 — ` +
      `서버가 기동될 때마다 credentialsBackfill.js가 자동으로 암호화하므로, 서버를 한 번도 안 띄운 상태이거나 백필이 오류로 중단됐을 수 있음(서버 로그의 "[백필] 자격증명 암호화 오류" 확인).`);
  }
}

// ── 7. 레시피 미지정 메뉴 (routes/api.js GET /menus/unassigned와 동일 조건) ──
async function checkUnassignedMenus() {
  // 레시피도 없고(recipes), 표준 메뉴 연결도 없고(recipe_source_menu_id), 세트 구성도 없는(menu_components)
  // 매장 메뉴 = menuResolver가 "아무것도 못 찾음"으로 판정해 소진량을 0으로 계산하는 것과 정확히 같은 조건.
  // routes/api.js의 GET /menus/unassigned와 같은 판정식을 그대로 따른다(그 파일은 수정하지 않음).
  const rows = await knex('menus as m')
    .join('stores as s', 'm.store_id', 's.id')
    .join('brands as b', 's.brand_id', 'b.id')
    .whereNotNull('m.store_id')
    .whereNull('m.recipe_source_menu_id')
    .whereNotExists(knex('recipes').whereRaw('recipes.menu_id = m.id'))
    .whereNotExists(knex('menu_components').whereRaw('menu_components.set_menu_id = m.id'))
    .select('m.id', 'm.name', 'm.is_active', 's.name as store_name', 'b.name as brand_name');

  if (rows.length === 0) {
    report('INFO', '레시피 미지정 메뉴', '없음 — 모든 매장 메뉴에 레시피/표준연결/세트구성 중 하나가 있음');
    return;
  }
  const activeCount = rows.filter(r => r.is_active).length;
  const level = activeCount > 0 ? 'WARN' : 'INFO';
  report(level, '레시피 미지정 메뉴',
    `총 ${rows.length}개(그중 판매 중 ${activeCount}개) — 팔려도 재고가 자동 차감되지 않는 메뉴. 본사 화면의 "미지정 메뉴" 목록에서 표준 메뉴 연결/레시피 등록/세트 구성 중 하나를 해줘야 사입 감시(UNDER_PURCHASE 등)가 정상 동작함.`);
}

// ── 8. 미해결 리스크 알림 ────────────────────────────────────────────────
async function checkOpenRisks() {
  const rows = await knex('risk_alerts as r')
    .join('brands as b', 'r.brand_id', 'b.id')
    .leftJoin('stores as s', 'r.store_id', 's.id')
    .whereIn('r.status', [RISK_STATUSES.OPEN, RISK_STATUSES.ACKNOWLEDGED, RISK_STATUSES.IN_PROGRESS])
    .select('r.type', 'r.severity', 'b.name as brand_name', 's.name as store_name');

  if (rows.length === 0) {
    report('INFO', '미해결 리스크 알림', '없음');
    return;
  }

  const byType = new Map();
  for (const r of rows) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }

  for (const [type, list] of byType) {
    const isSystemSignal = SYSTEM_SIGNAL_RISK_TYPES.has(type);
    const stores = [...new Set(list.map(r => `${r.brand_name}/${r.store_name || '(가맹점 없음)'}`))].slice(0, 10).join(', ');
    const more = list.length > 10 ? ` 외 ${list.length - 10}건` : '';
    if (isSystemSignal) {
      // MENU_UNMATCHED/NEGATIVE_STOCK/WEBHOOK_REJECTED/SYNC_FAILED — CLAUDE.md 2절: "시스템이 제 역할을
      // 못 하고 있다"는 신호. 방치되면 그 사이 재고·매출 데이터가 조용히 계속 틀어진다.
      report('FATAL', `미해결 리스크: ${type}`, `${list.length}건 — ${stores}${more} (시스템 신호성 리스크: 데이터 정합성이 계속 틀어지고 있을 가능성)`);
    } else {
      report('WARN', `미해결 리스크: ${type}`, `${list.length}건 — ${stores}${more}`);
    }
  }
}

// 점검 항목 하나가 죽어도(예: 마이그레이션이 밀려서 특정 테이블/컬럼이 아직 없는 DB) 나머지 점검까지
// 통째로 중단되면 안 된다 — 오히려 그 자체가 "마이그레이션 상태" 점검이 잡아야 할 상황과 겹치는
// 경우가 많다(예: menu_components 테이블이 없으면 7번 점검 쿼리가 그대로 예외를 던짐). 각 점검을
// 개별적으로 감싸서 실패해도 나머지 점검과 최종 리포트는 계속 진행되게 한다.
async function safeCheck(name, fn) {
  try {
    await fn();
  } catch (e) {
    report('FATAL', name, `점검 자체가 실패함(스키마가 최신이 아닐 가능성 — 마이그레이션 상태 점검 결과와 함께 확인할 것): ${e.message}`);
  }
}

// ── 실행 ────────────────────────────────────────────────────────────────
async function main() {
  const connected = await checkDbConnection();
  if (!connected) {
    // DB에 못 붙으면 나머지 점검은 전부 쿼리를 날리므로 의미가 없다 — 여기서 바로 마무리.
    printReport();
    await knex.destroy();
    process.exit(1);
  }

  await safeCheck('마이그레이션 상태', checkMigrations);
  await safeCheck('환경변수', checkEnvVars);
  await safeCheck('webhook_secret', checkWebhookSecrets);
  await safeCheck('toss_store_id', checkTossStoreIds);
  await safeCheck('자격증명 암호화', checkCredentialEncryption);
  await safeCheck('레시피 미지정 메뉴', checkUnassignedMenus);
  await safeCheck('미해결 리스크 알림', checkOpenRisks);

  printReport();
  await knex.destroy();
  const hasFatal = results.some(r => r.level === 'FATAL');
  process.exit(hasFatal ? 1 : 0);
}

function printReport() {
  console.log('\n========== 포스모스 배포 전 사전 점검 ==========');
  console.log(`환경: ${isProduction ? '운영 (DATABASE_URL 설정됨, Postgres)' : '로컬 (SQLite)'}\n`);

  for (const levelKey of ['FATAL', 'WARN', 'INFO']) {
    const items = results.filter(r => r.level === levelKey);
    if (items.length === 0) continue;
    console.log(`--- [${LEVEL[levelKey]}] ${items.length}건 ---`);
    for (const item of items) {
      console.log(`  [${item.check}] ${item.message}`);
    }
    console.log('');
  }

  const fatalCount = results.filter(r => r.level === 'FATAL').length;
  const warnCount = results.filter(r => r.level === 'WARN').length;
  console.log(`결과: 치명 ${fatalCount}건, 경고 ${warnCount}건`);
  console.log(fatalCount > 0 ? '치명 항목이 있어 배포를 중단하는 것을 권장합니다.' : '치명 항목 없음.');
  console.log('==================================================\n');
}

main().catch(async (e) => {
  console.error('[preflight] 예기치 못한 오류:', e);
  try { await knex.destroy(); } catch { /* 무시 */ }
  process.exit(1);
});
