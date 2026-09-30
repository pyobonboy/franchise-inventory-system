// 요청 빈도 제한 — 인증 여부와 무관하게 API를 무제한으로 때릴 수 있던 문제를 막는다.
// auth.js의 로그인 잠금(이메일 기준 5회/15분, 메모리 Map + 주기 정리)과 같은 스타일로,
// 별도 의존성(express-rate-limit 등) 없이 고정 윈도(fixed window) 카운터로 직접 구현한다.
//
// 한도 산정 근거 (client/src/components/StockAlert.jsx, client/src/App.jsx 기준):
// - StockAlert: 3분마다 대시보드+리스크 2건 → 분당 약 0.7건
// - App.jsx(HQLayout): 1분마다 리스크+내업무 2건 → 분당 2건
// - 위 폴링만 보면 로그인 사용자 1명당 정상 트래픽은 분당 3건 안팎이지만, 실제로는:
//   - 가맹점 매장 하나에 단말 여러 대가 같은 공유기(NAT) IP를 쓸 수 있음
//   - 페이지 이동/새로고침 시 그 화면의 여러 API를 한꺼번에 병렬로 호출함 (대시보드 등)
//   - 이 미들웨어는 IP 단위로 묶이므로 폴링 몇 개보다 훨씬 넉넉하게 잡아야 정상 사용을 막지 않는다
// IP당 분당 300건(초당 5건 평균)으로 설정 — 정상적인 폴링/화면 전환 트래픽의 수십 배 여유를 두면서도
// 스크립트로 초당 수십~수백 건씩 때리는 남용은 걸러낸다.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 300;

// 이 경로들은 절대 제한하면 안 된다:
// - /health: 배포 플랫폼이 짧은 간격으로 계속 호출하는 생존 확인용
// - 토스 웹훅(/webhook/:storeId, /api/orders/toss-webhook): 매출이 몰리는 시간대에 웹훅이 막히면
//   주문이 유실된다. 토스는 실패한 웹훅을 무한정 재시도하지 않으므로 이건 실제 매출 손실로 이어진다.
//   routes/webhook.js의 실제 경로는 '/webhook/:storeId'라 가맹점마다 다른 하위 경로로 들어온다 —
//   '/webhook'과 정확히 같은 문자열만 비교하면 실제 웹훅 요청('/webhook/42' 등)은 하나도 걸러지지
//   않고 그대로 제한당하므로, 반드시 하위 경로까지 포함하는 접두사(prefix)로 비교해야 한다.
function isExemptPath(path) {
  return path === '/health'
    || path === '/api/orders/toss-webhook'
    || path === '/webhook' || path.startsWith('/webhook/');
}

// IP -> { count, windowStart }
const buckets = new Map();

// 단일 프로세스 메모리 기반이라는 한계: 인스턴스를 여러 개(오토스케일) 띄우면 인스턴스마다 따로 세므로
// 실제 허용량은 인스턴스 수배로 늘어난다. 지금처럼 서버 인스턴스가 하나인 배포 형태에서는 문제 없지만,
// 나중에 다중 인스턴스로 늘리면 Redis 등 공유 스토어로 옮겨야 의도한 한도가 정확히 지켜진다.
function rateLimit(req, res, next) {
  if (isExemptPath(req.path)) return next();

  // Render 등은 리버스 프록시 뒤에서 돈다 — index.js에서 app.set('trust proxy', 1)을 해둬야
  // req.ip가 실제 클라이언트 IP가 되고, 안 해두면 모든 요청이 프록시 IP 하나로 묶여 사실상
  // 서비스 전체가 하나의 버킷을 공유하게(= 한 사람만 남용해도 전체가 막힘) 된다.
  const key = req.ip || 'unknown';
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' });
  }
  next();
}

// auth.js의 cleanupLoginAttempts와 같은 이유 — 한 번 왔다가 다시 안 오는 IP(윈도가 끝났는데
// 재조회가 없어 자연스럽게 안 지워지는 항목)가 계속 쌓여 메모리를 갉아먹지 않도록 주기적으로 비운다.
const CLEANUP_MS = WINDOW_MS * 5;
function cleanupBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= WINDOW_MS) buckets.delete(key);
  }
}
const cleanupTimer = setInterval(() => {
  try { cleanupBuckets(); } catch (e) { console.error('[rate-limit] 정리 오류:', e.message); }
}, CLEANUP_MS);
cleanupTimer.unref(); // 이 타이머 때문에 프로세스 종료(graceful shutdown)가 늦어지면 안 됨

module.exports = rateLimit;
