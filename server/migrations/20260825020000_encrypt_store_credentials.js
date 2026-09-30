'use strict';

// 기존에 평문으로 저장된 stores.webhook_secret / stores.toss_client_secret / store_integrations.credentials
// (JSON의 client_secret)를 CREDENTIALS_KEY가 설정된 뒤 암호화한다. 판별/암복호화 로직은
// server/src/crypto.js를 그대로 재사용한다 — 접두사('enc:v1:') 판별식이 여기와 흩어지면, 나중에
// 한쪽만 바뀌었을 때 이 마이그레이션이 이미 암호화된 값을 다시 암호화하거나(이중 암호화로 시크릿을
// 영구히 잃음) 반대로 놓치는 사고가 날 수 있다.
const { encryptCredential, decryptCredential, isEncrypted, hasKey } = require('../src/crypto');

async function migrateStoreColumns(knex, transform) {
  const stores = await knex('stores').select('id', 'webhook_secret', 'toss_client_secret');
  for (const store of stores) {
    const update = {};
    if (store.webhook_secret) {
      const next = transform(store.webhook_secret);
      if (next !== store.webhook_secret) update.webhook_secret = next;
    }
    if (store.toss_client_secret) {
      const next = transform(store.toss_client_secret);
      if (next !== store.toss_client_secret) update.toss_client_secret = next;
    }
    if (Object.keys(update).length > 0) {
      await knex('stores').where({ id: store.id }).update(update);
    }
  }
}

// store_integrations.credentials는 JSON 문자열이고 provider별로 형태가 다르다(TOSS_PLACE는
// external_id만 쓰고 credentials가 비어있을 수 있음). client_secret 필드가 있는 행(TOSS_PAYMENTS)만
// 대상으로 한다 — dbHelpers.js의 syncStoreIntegrations가 만드는 형태({client_id, client_secret})와 맞춘다.
async function migrateIntegrationCredentials(knex, transform) {
  const rows = await knex('store_integrations').whereNotNull('credentials').select('id', 'credentials');
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.credentials);
    } catch {
      continue; // JSON이 아니면 이 마이그레이션이 다룰 대상이 아니므로 건드리지 않는다
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.client_secret !== 'string' || !parsed.client_secret) {
      continue;
    }
    const nextSecret = transform(parsed.client_secret);
    if (nextSecret === parsed.client_secret) continue;
    parsed.client_secret = nextSecret;
    await knex('store_integrations').where({ id: row.id }).update({ credentials: JSON.stringify(parsed) });
  }
}

exports.up = async function up(knex) {
  // 키가 없으면 아무것도 하지 않고 조용히 통과한다 — 키 없는 환경(로컬, 아직 CREDENTIALS_KEY를
  // 안 넣은 배포)에서 이 마이그레이션 때문에 서버 기동이 막히면 안 된다(웹훅 서명 검증이
  // store.webhook_secret을 못 읽어 전부 401이 되어 매출 유입이 끊긴다).
  if (!hasKey()) return;

  // 이미 암호화된 값(접두사 있음)은 그대로 두어 이중 암호화를 막는다 — 마이그레이션이 여러 번
  // 실행돼도(예: 재배포마다 knex.migrate.latest()가 도는데 이 파일이 이미 적용된 상태) 안전해야 한다.
  const encryptIfPlain = (value) => (isEncrypted(value) ? value : encryptCredential(value));
  await migrateStoreColumns(knex, encryptIfPlain);
  await migrateIntegrationCredentials(knex, encryptIfPlain);
};

exports.down = async function down(knex) {
  // up과 동일한 이유로, 키가 없으면 아무것도 하지 않는다 — 애초에 키가 없으면 암호화된 값을
  // 복호화할 방법도 없다(crypto.js의 decryptCredential이 키 없이 암호문을 받으면 에러를 던진다).
  if (!hasKey()) return;

  const decryptIfEncrypted = (value) => (isEncrypted(value) ? decryptCredential(value) : value);
  await migrateStoreColumns(knex, decryptIfEncrypted);
  await migrateIntegrationCredentials(knex, decryptIfEncrypted);
};
