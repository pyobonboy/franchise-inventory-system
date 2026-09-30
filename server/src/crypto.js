'use strict';

/**
 * 자격증명(stores.webhook_secret, stores.toss_client_secret, store_integrations.credentials 안의
 * client_secret) 암/복호화. CLAUDE.md 6절 "토스 자격증명이 평문으로 저장된다" 항목의 후속 조치.
 *
 * 설계 원칙:
 *
 * 1. CREDENTIALS_KEY 환경변수가 없으면 암호화하지 않고 기존처럼 평문 그대로 저장/조회한다.
 *    지금 개발 중인 로컬 환경과 이미 떠 있는 운영 환경이 이 키 없이 돌고 있어서, 키를 필수로
 *    만들면 서버가 기동하지 못하거나(웹훅 서명 검증에 쓰는 store.webhook_secret을 못 읽으면)
 *    웹훅이 전부 401이 되어 매출 유입이 끊긴다. 대신 운영(DATABASE_URL 존재)인데 키가 없으면
 *    기동 시 경고 로그를 한 번 남긴다 — index.js는 건드리지 않고 여기서 처리한다(최초로 이
 *    모듈을 require하는 시점, 보통 서버 기동 직후에 로그가 찍힌다).
 * 2. 평문과 암호문이 한 DB에 섞여 있어도 안전하게 읽을 수 있어야 한다(키를 막 설정한 직후,
 *    마이그레이션 도중/롤백 등). 암호문에는 'enc:v1:' 접두사를 붙이고, 복호화 함수는 이 접두사가
 *    없으면 무조건 평문으로 간주해 그대로 반환한다.
 * 3. 접두사가 있는데(=과거에 암호화됐던 값인데) 복호화(GCM 인증 태그 검증 포함)에 실패하면 절대
 *    조용히 넘어가지 않는다. 키가 바뀌었거나 데이터가 손상된 상황을 "평문처럼 보이는 값"으로
 *    오인해서 반환하면(예: 깨진 값을 그대로 웹훅 HMAC 시크릿으로 써버리면) 서명 검증이 이유 없이
 *    계속 실패하는 것처럼 보여 원인 파악이 훨씬 어려워진다. 그래서 명확한 에러를 던진다 — 호출부
 *    (예: webhook.js의 handleWebhook)의 기존 try/catch가 이를 잡아 500과 에러 로그로 이어진다.
 *
 * 알고리즘: AES-256-GCM, Node 내장 crypto만 사용(새 의존성 추가 없음). 인증 태그가 있어 변조를
 * 감지할 수 있다. 값마다 새 IV(12바이트, GCM 권장 길이)를 생성하고 [iv][authTag][ciphertext]를
 * 이어붙여 base64로 인코딩한 뒤 'enc:v1:' 접두사를 붙인다.
 *
 * 키 생성 방법 (운영에 배포하기 전 한 번 실행해서 나온 값을 CREDENTIALS_KEY로 설정 — hex 64자 = 32바이트):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// db/schema.js와 동일한 판별식이지만, crypto.js는 DB 계층에 의존하지 않는 순수 유틸리티로 두기 위해
// 여기서 독립적으로 계산한다(schema.js를 require하면 knex 인스턴스까지 딸려온다).
const isProduction = !!process.env.DATABASE_URL;

let cachedKey; // undefined = 아직 안 읽음, null = 키 없음, Buffer = 유효한 키
let warnedMissingKeyInProduction = false;

function loadKey() {
  if (cachedKey !== undefined) return cachedKey;

  const raw = process.env.CREDENTIALS_KEY;
  if (!raw) {
    if (isProduction && !warnedMissingKeyInProduction) {
      warnedMissingKeyInProduction = true;
      console.warn(
        '[crypto] CREDENTIALS_KEY가 설정되지 않았습니다 — webhook_secret/toss_client_secret이 ' +
        "DB에 평문으로 저장됩니다. 생성: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
      );
    }
    cachedKey = null;
    return cachedKey;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'CREDENTIALS_KEY 형식이 올바르지 않습니다. hex로 인코딩된 32바이트(64자)여야 합니다. ' +
      "생성: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  cachedKey = Buffer.from(raw, 'hex');
  return cachedKey;
}

function hasKey() {
  return !!loadKey();
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

// null/undefined/''는 "값 없음"을 그대로 보존해야 한다 — 호출부(예: api.js의 `webhook_secret || ''`,
// dbHelpers.js의 `!= null` 체크)가 빈 값과 실제 시크릿을 구분하는 로직을 그대로 쓸 수 있어야 하므로
// 암호화 대상에서 제외한다.
function encryptCredential(plainText) {
  if (plainText == null || plainText === '') return plainText;
  const key = loadKey();
  if (!key) return plainText; // 키 없음 → 기존 동작(평문 저장) 유지

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decryptCredential(value) {
  if (value == null || value === '') return value;
  if (!isEncrypted(value)) return value; // 접두사 없음 → 평문으로 간주(설계 원칙 2)

  const key = loadKey();
  if (!key) {
    // 접두사가 있다는 건 과거에 키가 있는 상태로 암호화됐다는 뜻인데 지금은 키가 없어 복호화할
    // 방법이 없다. 이걸 평문인 척 그대로 반환하면(설계 원칙 3) 예를 들어 웹훅 HMAC 검증에
    // 암호문 자체가 시크릿으로 쓰여 이유를 알 수 없이 서명 검증이 계속 실패하게 된다.
    throw new Error('CREDENTIALS_KEY 없이 암호화된 자격증명을 복호화할 수 없습니다.');
  }

  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    // GCM 인증 태그 검증 실패 = 키가 바뀌었거나 데이터가 변조/손상됨. 조용히 넘어가지 않고
    // (설계 원칙 3) 여기서 명확히 에러를 던진다.
    throw new Error(`자격증명 복호화 실패(키 불일치 또는 데이터 손상 가능): ${error.message}`);
  }
}

module.exports = { encryptCredential, decryptCredential, isEncrypted, hasKey, PREFIX };
