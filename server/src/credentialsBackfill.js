'use strict';

// 서버 기동마다 도는 자기 치유(self-healing) 자격증명 암호화 백필.
//
// 왜 마이그레이션(20260825020000_encrypt_store_credentials.js)만으로 부족한가:
// knex 마이그레이션은 한 번 "적용됨"으로 기록되면 knex_migrations 테이블에 남아 다시는 실행되지
// 않는다. 그 마이그레이션은 CREDENTIALS_KEY가 없으면 아무것도 하지 않고 조용히 통과하도록 되어
// 있는데(키를 필수로 만들면 키 없이 이미 떠 있는 배포가 못 뜬다), 그 상태로 배포되면 "적용됨"
// 기록만 남고 실제로는 아무 것도 암호화하지 않는다. 이후 CREDENTIALS_KEY를 뒤늦게 추가해
// 재배포해도 knex는 이미 적용된 마이그레이션을 다시 돌리지 않으므로, 기존 평문 자격증명은
// 영영 암호화되지 않는다. CREDENTIALS_KEY는 선택 환경변수라 최초 배포에서 빠뜨리기 쉬워서 실제로
// 자주 발생할 수 있는 순서다.
//
// 이 모듈은 매 기동마다 실행되므로 "나중에 키를 추가한" 경우도 다음 배포에서 자동으로 해결된다.
// 마이그레이션 파일은 지우지 않는다 — 로컬 등 이미 적용된 환경에서 파일이 사라지면 knex가
// "migration directory is corrupt" 에러를 낸다. 대상/판별식이 완전히 같아 둘 다 이미 암호화된
// 값은 건너뛰므로(이중 암호화 없음) 마이그레이션과 이 백필이 같은 배포에서 동시에 돌아도 안전하다.
//
// 대상과 처리 방식은 마이그레이션과 동일하게 맞춘다:
// - stores.webhook_secret, stores.toss_client_secret
// - store_integrations.credentials (JSON 안의 client_secret 필드가 있는 행만)
const { encryptCredential, isEncrypted, hasKey } = require('./crypto');

async function backfillStoreColumns(knex) {
  // 두 컬럼 중 하나라도 값이 있는 행만 대상으로 좁혀서 불필요한 전체 조회를 피한다.
  const stores = await knex('stores')
    .whereNotNull('webhook_secret').orWhereNotNull('toss_client_secret')
    .select('id', 'webhook_secret', 'toss_client_secret');
  let count = 0;
  for (const store of stores) {
    const update = {};
    if (store.webhook_secret && !isEncrypted(store.webhook_secret)) {
      update.webhook_secret = encryptCredential(store.webhook_secret);
    }
    if (store.toss_client_secret && !isEncrypted(store.toss_client_secret)) {
      update.toss_client_secret = encryptCredential(store.toss_client_secret);
    }
    if (Object.keys(update).length > 0) {
      await knex('stores').where({ id: store.id }).update(update);
      count++;
    }
  }
  return count;
}

async function backfillIntegrationCredentials(knex) {
  const rows = await knex('store_integrations').whereNotNull('credentials').select('id', 'credentials');
  let count = 0;
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.credentials);
    } catch {
      continue; // JSON이 아니면 이 백필이 다룰 대상이 아니다
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.client_secret !== 'string' || !parsed.client_secret) {
      continue;
    }
    if (isEncrypted(parsed.client_secret)) continue; // 이미 암호화됨 — 건너뛰어 이중 암호화 방지
    parsed.client_secret = encryptCredential(parsed.client_secret);
    await knex('store_integrations').where({ id: row.id }).update({ credentials: JSON.stringify(parsed) });
    count++;
  }
  return count;
}

// index.js에서 initDb() 완료 후(마이그레이션까지 끝난 시점) 호출한다.
async function backfillCredentials(knex) {
  if (!hasKey()) return; // 키 없음 → 할 일 없음. crypto.js가 이미 운영에서 키 없음을 경고하므로 여기선 로그 안 남김

  try {
    const storeCount = await backfillStoreColumns(knex);
    const integrationCount = await backfillIntegrationCredentials(knex);
    const total = storeCount + integrationCount;
    if (total > 0) {
      console.log(`[백필] 자격증명 암호화 ${storeCount}개 가맹점, ${integrationCount}건 연동 완료`);
    }
  } catch (e) {
    // 백필 실패가 서버 기동을 막으면 안 된다 — 자격증명이 평문으로 남는 건 문제지만, 그것 때문에
    // 서비스 전체가 안 뜨는 건 더 큰 문제다.
    console.error('[백필] 자격증명 암호화 오류:', e.message);
  }
}

module.exports = { backfillCredentials };
