// 창 계산과 실패 시 재시도 창 판정이 index.js의 runAutoSync 안에 인라인으로 있어 테스트가
// 원천적으로 불가능했다(sync-window.test.js가 락과 syncStoreSales만 검증할 수 있었던 이유).
// 부수효과 없는 순수 함수 둘만 뽑아 규칙 자체를 검증 가능하게 한다 — 파일 분리 리팩터링이
// 아니라 테스트 가능성 확보가 목적이다.

// last_synced_at 직전 여유 — 이 폭만큼은 항상 다시 훑어서, 직전 실행이 끝나기 직전에 들어온
// 주문(from/to 경계에 걸쳐 놓친 주문)을 다음 실행이 다시 잡게 한다.
const SYNC_OVERLAP_MS = 10 * 60 * 1000;
// 서버가 며칠씩 멈췄다 살아나도 최소 이 기간은 항상 다시 본다. 예전엔 last_synced_at의 null
// 여부로만 "최초냐 아니냐"를 가르고 창은 항상 "최근 2일" 고정이었다 — 서버가 3일 이상 멈추면
// 그 구간이 last_synced_at은 갱신됐으나 실제로는 한 번도 안 훑은 채 영구 누락됐다.
const SYNC_MIN_WINDOW_MS = 2 * 86400000;
// 최초 동기화(한 번도 동기화 안 한 가맹점)만 전체 매출(최근 5년)을 가져온다.
const SYNC_INITIAL_MS = 5 * 365 * 86400000;

// lastSyncedAt: ISO 문자열 | null, nowTs: epoch ms
// → { fromTs, toTs, lastTs }   lastTs는 null이면 최초 동기화
function computeSyncWindow(lastSyncedAt, nowTs) {
  const lastTs = lastSyncedAt ? new Date(lastSyncedAt).getTime() : null;
  const toTs = nowTs;
  const fromTs = lastTs !== null
    ? Math.min(lastTs - SYNC_OVERLAP_MS, toTs - SYNC_MIN_WINDOW_MS)
    : toTs - SYNC_INITIAL_MS;
  return { fromTs, toTs, lastTs };
}

// 동기화 실패 시 last_synced_at을 어디까지 밀지 판정한다.
// → { retryFloorTs, advanced }
//   advanced=true면 "재시도 창이 앞으로 밀려 그 이전 구간을 포기했다"는 뜻 →
//   호출부는 연속 실패 횟수와 무관하게 즉시 SYNC_FAILED 리스크를 만든다.
function computeFailureOutcome(lastTs, toTs) {
  const retryFloorTs = toTs - SYNC_MIN_WINDOW_MS;
  const advanced = (lastTs === null) || (retryFloorTs > lastTs);
  return { retryFloorTs, advanced };
}

module.exports = { computeSyncWindow, computeFailureOutcome, SYNC_OVERLAP_MS, SYNC_MIN_WINDOW_MS, SYNC_INITIAL_MS };
