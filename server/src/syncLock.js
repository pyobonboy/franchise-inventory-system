// 가맹점 단위 매출 동기화 잠금.
//
// 예전엔 수동 동기화(api.js의 syncInProgress Set)와 크론(index.js의 withOverlapGuard)이 서로 다른
// 프로세스 메모리 가드를 써서 같은 매장에 동시에 돌 수 있었다. Postgres(READ COMMITTED)에서는 두 트랜잭션이
// 같은 주문을 각각 "처음 보는 주문"으로 판단해 재고가 이중 차감/이중 복구됐다(sqlite는 커넥션 풀이 1개라
// 직렬화되어 드러나지 않았을 뿐이다).
//
// stores.sync_locked_at 컬럼 하나에 대한 조건부 UPDATE로 선점한다. knex `.update()`의 반환값(영향 행 수)은
// sqlite3/pg 모두 정수라 방언 분기가 필요 없다 — orders.js의 `stock_applied=false` 선점과 같은 패턴이다.
// TTL(30분)은 프로세스가 죽어 락이 남았을 때 자동 회수하기 위한 것이다. 최초 5년치 동기화가 그 안에 끝나지
// 않으면 두 실행이 겹칠 수 있다는 한계는 남는다.
//
// 잠금 값은 ISO 문자열을 직접 쓴다(`knex.fn.now()` 금지 — 비교가 방언별로 갈라진다, dbTime.js 참고).
const SYNC_LOCK_TTL_MS = 30 * 60 * 1000;

// 반환: 잠금을 잡았으면 { ok: true, stamp }, 다른 실행이 잡고 있으면 { ok: false, stamp: null }
async function acquireStoreSyncLock(knexOrTrx, storeId) {
  const stamp = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - SYNC_LOCK_TTL_MS).toISOString();
  const n = await knexOrTrx('stores')
    .where({ id: storeId })
    .where(b => b.whereNull('sync_locked_at').orWhere('sync_locked_at', '<', staleCutoff))
    .update({ sync_locked_at: stamp });
  return n === 1 ? { ok: true, stamp } : { ok: false, stamp: null };
}

// 내가 잡은 stamp일 때만 해제한다. stamp가 다르면(TTL 만료 후 다른 실행이 가져감) 아무것도 하지 않는다.
async function releaseStoreSyncLock(knexOrTrx, storeId, stamp) {
  if (!stamp) return;
  await knexOrTrx('stores').where({ id: storeId, sync_locked_at: stamp }).update({ sync_locked_at: null });
}

module.exports = { acquireStoreSyncLock, releaseStoreSyncLock, SYNC_LOCK_TTL_MS };
