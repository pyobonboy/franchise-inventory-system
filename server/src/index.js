require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initDb, knex, isProduction } = require('./db/schema');
const { RISK_STATUSES, RISK_TYPES, RISK_SEVERITIES } = require('./constants');
const { syncStoreIntegrations } = require('./dbHelpers');
const { backfillCredentials } = require('./credentialsBackfill');
const { backfillMenuTossIds } = require('./menuLinking');
const { dbTimeAgo } = require('./dbTime');
const requestLog = require('./middleware/requestLog');
const rateLimit = require('./middleware/rateLimit');

const app = express();

// Render 등 배포 환경은 리버스 프록시 뒤에서 실행된다. 이걸 설정하지 않으면 req.ip가 항상 프록시의
// IP가 되어 (1) 아래 rateLimit 미들웨어가 모든 사용자를 하나의 버킷으로 묶어버리고 (2) 로그에 남는
// 클라이언트 IP도 의미가 없어진다. 신뢰하는 홉이 하나(플랫폼의 엣지 프록시)뿐이므로 1로 설정.
app.set('trust proxy', 1);

// 프로세스가 종료 신호(SIGTERM/SIGINT)를 받아 정리 중인 동안 로드밸런서가 새 요청을 이 인스턴스로
// 계속 보내지 않도록 /health를 즉시 실패시키기 위한 플래그. 파일 하단 graceful shutdown 참고.
let shuttingDown = false;

app.use(requestLog);

// 허용 출처: 로컬 개발(localhost), Cloudflare Quick Tunnel(*.trycloudflare.com — 시작.bat에서 매번 임의 주소 생성),
// 운영 환경에 설정한 CLIENT_URL. 그 외 출처는 차단.
// localhost/trycloudflare/onrender 와일드카드는 개발 편의용이라 운영에서까지 열어두면 아무 Render/Cloudflare
// 호스트나 우리 서버에 인증된 요청을 보낼 수 있게 된다 — 운영에서는 CLIENT_URL에 명시한 출처만 허용한다.
// CLIENT_URL은 render.yaml에서 스킴 없이(호스트명만) 넣기 쉬운데, 브라우저가 보내는 Origin 헤더는
// 항상 스킴을 포함하므로 그대로 비교하면 일치하지 않아 운영 프론트엔드가 전부 CORS 차단된다.
// client/src/api.js의 normalizeApiBase와 같은 계열로, 스킴 없으면 https://를 붙이고 끝 슬래시를 제거한다.
const extraOrigins = (process.env.CLIENT_URL || '').split(',').map(s => s.trim()).filter(Boolean)
  .map(s => (/^https?:\/\//.test(s) ? s : `https://${s}`).replace(/\/$/, ''));
if (isProduction && extraOrigins.length === 0) {
  // CLIENT_URL이 비어 있으면 아래 로직상 프론트엔드 출처까지 전부 막혀 서비스가 죽는다 — 배포 설정 누락을
  // 조용히 넘기지 않고 눈에 띄게 경고한다 (render.yaml에는 sync:false로 선언만 되어 있어 값은 대시보드에서 직접 넣어야 함)
  console.warn('[CORS] 운영 환경인데 CLIENT_URL이 설정되어 있지 않습니다. 프론트엔드 요청이 모두 CORS로 차단됩니다.');
}
const corsOriginCheck = (origin, callback) => {
  if (!origin) return callback(null, true); // 서버-서버 호출, 웹훅 등 Origin 헤더 없는 요청
  const allowed = isProduction
    ? extraOrigins.includes(origin)
    : /^https?:\/\/localhost(:\d+)?$/.test(origin)
      || /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin)
      || /^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin)
      || extraOrigins.includes(origin);
  callback(allowed ? null : new Error('CORS blocked'), allowed);
};
app.use(cors({ origin: corsOriginCheck }));
// 토스 결제/토스플레이스 웹훅은 서명 검증을 위해 raw body가 필요해서 express.json()보다 먼저 등록
// (이 등록이 없으면 express.json()이 먼저 바디를 다 읽어버려서, 아래 webhook.js의 express.raw()는
// 빈 스트림만 보게 되어 서명(HMAC)이 항상 빈 바디로 계산되고 실제 토스 서명과 일치하지 않아 모든
// 서명된 웹훅이 401로 거부되는 문제가 있었음)
// 웹훅 raw body 크기 제한: 서명 검증 전에 바디를 끝까지 읽어들이는 구조라(위 주석 참고),
// 제한이 없으면 인증 없이(서명만 안 맞으면 어차피 401이지만, 그 401을 내려주기 전에) 거대한
// 바디를 계속 흘려보내는 것만으로 메모리를 고갈시킬 수 있다. 실제 토스 웹훅 페이로드는 주문
// 한 건 분량이라 훨씬 작으므로 256kb면 충분히 여유 있다.
app.use('/api/orders/toss-webhook', express.raw({ type: 'application/json', limit: '256kb' }));
app.use('/webhook', express.raw({ type: 'application/json', limit: '256kb' }));
// 기본값(100kb)에 암묵적으로 의존하고 있었다. 발주서 생성(routes/orders.js)이 품목 배열(items)을
// 통째로 받는데, 품목이 많은 발주서가 100kb를 넘길 수 있어 명시적으로 넉넉하게 잡는다.
app.use(express.json({ limit: '1mb' }));

// 로그인 잠금(auth.js) 외에는 인증 여부와 무관하게 API를 무제한으로 호출할 수 있었다.
// 몸통 파싱 이후, 실제 라우트 마운트 이전에 걸어 모든 API 요청에 적용한다.
app.use(rateLimit);

// 배포 플랫폼이 인스턴스 생존 여부를 판단하는 용도 — 인증 없이 접근 가능해야 하므로 별도 라우터의
// requireAuth를 거치지 않는 최상위 경로에 둔다. 프로세스가 떠 있는 것만으로는 부족하고(DB가 죽었는데
// 서버 프로세스만 살아있으면 트래픽이 계속 이 인스턴스로 온다) 실제로 DB에 붙는지 가벼운 쿼리로 확인한다.
app.get('/health', async (req, res) => {
  // graceful shutdown 진행 중에는 DB 상태와 무관하게 즉시 실패시켜서, 로드밸런서/플랫폼이 이 인스턴스로
  // 새 요청을 그만 보내도록 유도한다 (진행 중인 요청이 끝나기를 기다리는 동안 새 요청이 계속 들어오면
  // graceful shutdown이 끝나지 않거나 그 요청들이 강제 종료에 휘말린다).
  if (shuttingDown) {
    return res.status(503).json({ status: 'shutting_down' });
  }

  // DB가 멈춰있을 때(네트워크 단절, 커넥션 풀 고갈 등) 쿼리가 영영 안 끝나면 이 요청도 같이 매달리고,
  // 매달린 헬스체크 요청이 쌓이면 프로브가 타임아웃으로도 못 잡아내는 상황이 된다 — 반드시 자체 타임아웃을 둔다.
  const HEALTH_DB_TIMEOUT_MS = 3000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('db health check timeout')), HEALTH_DB_TIMEOUT_MS);
  });

  try {
    // select 1 수준의 가벼운 쿼리만 — 프로브가 자주(짧은 간격으로) 호출하므로 무거운 쿼리는 금지.
    await Promise.race([knex.raw('select 1'), timeout]);
    clearTimeout(timer);
    res.status(200).json({ status: 'ok' });
  } catch (e) {
    clearTimeout(timer);
    // 내부 정보(DB 접속 문자열, 스택, 버전 상세)는 응답에 담지 않는다 — 서버 로그에서만 원인을 본다.
    console.error('[헬스체크] DB 확인 실패:', e.message);
    res.status(503).json({ status: 'error' });
  }
});

const apiRoutes = require('./routes/api');
app.use('/auth', require('./routes/auth'));
app.use('/api', apiRoutes);
app.use('/api/orders', require('./routes/orders'));
app.use('/api/products', require('./routes/products'));
app.use('/api/waste', require('./routes/waste'));
app.use('/api/risks', require('./routes/risks').router);
app.use('/api/notices', require('./routes/notices'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/order-templates', require('./routes/orderTemplates'));
app.use('/webhook', require('./routes/webhook'));
app.use('/sse', require('./routes/sse').router);

// 전역 에러 핸들러: 라우트에서 처리되지 않은 예외/거부를 안전하게 500으로 응답
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다' });
});

const PORT = process.env.PORT || 3001;
// graceful shutdown에서 접근해야 하므로 initDb().then() 콜백 바깥(모듈 스코프)에 선언해둔다.
let server;
let overdueInterval, lowStockInterval, autoSyncInterval, dataCleanupInterval;
// 크론 러너(withOverlapGuard가 감싼 함수들)의 참조. initDb().then() 콜백 안에서 정의되므로,
// graceful shutdown(finish())이 "지금 진행 중인 크론이 있는지"를 물어보려면 모듈 스코프에 담아둬야 한다.
let cronRunners = [];
initDb().then(async () => {
  server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  // 자격증명(webhook_secret/toss_client_secret/store_integrations.credentials) 암호화 자기 치유 백필.
  // 마이그레이션(20260825020000_encrypt_store_credentials.js)은 한 번 적용되면 다시 안 돌기 때문에,
  // "키 없이 먼저 배포 → 나중에 CREDENTIALS_KEY 추가 후 재배포"하면 기존 평문이 영영 암호화되지
  // 않는 문제가 있다. 이 백필은 기동마다 실행되므로 그 경우를 자동으로 해결한다. 자세한 이유는
  // credentialsBackfill.js 상단 주석 참고.
  await backfillCredentials(knex);

  // 사입 감시(레시피 기반 예상 소진량 계산)가 메뉴명 문자열 비교에만 의존하면 가맹점이 POS에서
  // 메뉴 이름만 바꿔서 감시를 피해갈 수 있다. 토스가 매 주문마다 함께 보내는 메뉴 고유 ID는
  // 이름이 바뀌어도 그대로이므로, 이미 sales_items에 쌓여 있는 ID를 menus.toss_menu_id에
  // 연결해두면 이름이 바뀌어도 계속 같은 메뉴로 매칭된다. 자세한 이유/안전장치는 menuLinking.js
  // 상단 주석 참고. credentialsBackfill과 같은 "기동마다 도는 자기 치유 백필" 패턴이라 여기 나란히 둔다.
  await backfillMenuTossIds(knex);

  // 기존 orders → sales_items 백필 (sales_items가 비어있을 때 한 번만)
  try {
    const existingCount = await knex('sales_items').count('id as cnt').first();
    if (Number(existingCount.cnt) === 0) {
      // orders 전 행을 한 번에 메모리에 올리면 매출이 쌓인 운영 DB에서 기동 시 OOM 위험이 있다 —
      // id 기준 커서로 500건씩 끊어 읽는다.
      let filled = 0;
      let lastId = 0;
      const BACKFILL_CHUNK_SIZE = 500;
      while (true) {
        const orders = await knex('orders')
          .select('id', 'toss_order_id', 'store_id', 'brand_id', 'processed_at', 'raw_payload')
          .where('id', '>', lastId).orderBy('id').limit(BACKFILL_CHUNK_SIZE);
        if (orders.length === 0) break;
        for (const o of orders) {
          try {
            const payload = JSON.parse(o.raw_payload);
            const lineItems = (payload.data?.order?.lineItems) || (payload.data?.lineItems) || [];
            const soldAt = (payload.data?.order?.createdAt) || (payload.data?.createdAt) || o.processed_at;
            for (const item of lineItems) {
              const menuName = (item.item?.title) || item.name || item.menuName || '';
              const menuId = (item.item?.id) || item.menuId || null;
              const qty = item.quantity || 1;
              const unitPrice = (item.itemPrice?.priceValue) || (item.item?.price) || item.unitPrice || item.price || 0;
              if (!menuName) continue;
              await knex('sales_items').insert({
                brand_id: o.brand_id, store_id: o.store_id,
                toss_order_id: o.toss_order_id, menu_name: menuName, toss_menu_id: menuId,
                quantity: qty, unit_price: unitPrice, amount: unitPrice * qty,
                sold_at: soldAt,
              }).onConflict(['toss_order_id', 'menu_name']).ignore();
              filled++;
            }
          } catch {}
        }
        lastId = orders[orders.length - 1].id;
        if (orders.length < BACKFILL_CHUNK_SIZE) break;
      }
      if (filled > 0) console.log(`[백필] sales_items ${filled}건 마이그레이션 완료`);
    }
  } catch (e) { console.error('[백필] 오류:', e.message); }

  // 이전 실행이 아직 끝나지 않았으면 겹쳐 돌지 않도록 건너뛰는 래퍼. graceful shutdown이 진행 중인
  // 크론을 기다려야 하는데(재고 트랜잭션이 한창인 크론을 knex.destroy()가 끊어버리면 그 트랜잭션이
  // 어중간하게 남는다), 지금까지는 running 플래그가 클로저 안에 갇혀 있어 밖에서 조회할 방법이
  // 없었다 — wrapped.isRunning()으로 열어준다.
  function withOverlapGuard(name, fn) {
    let running = false;
    const wrapped = async () => {
      if (running) { console.log(`[크론] ${name} 이전 실행이 아직 진행 중이라 건너뜀`); return; }
      running = true;
      try { await fn(); } finally { running = false; }
    };
    wrapped.isRunning = () => running;
    return wrapped;
  }

  // 크론 예외를 일반 로그와 섞이지 않게 눈에 띄는 형태로 남긴다. 아래 3개 크론(결제 미완료 체크/
  // 재고 부족 체크/오래된 데이터 정리)은 브랜드 단위로 돌아 store_id가 없어 risk_alerts(가맹점 단위
  // 알림)로 옮기기 애매하고, 무엇보다 재고 부족·결제 미완료 체크 자체가 risk_alerts에 쓰는 주체라서
  // 그 실패를 risk_alerts로 알리면 "알림 시스템이 고장났다는 사실을 알림 시스템으로 알리는" 순환
  // 의존이 생긴다(예: 재고 부족 체크가 매번 예외로 죽으면 risk_alerts에 아무것도 안 쌓이므로, 그
  // 실패 자체를 risk_alerts에 기록하려는 시도도 같이 안 될 수 있음). 이 실패를 놓치지 않으려면
  // 결국 로그/외부 모니터링(APM 등)이 필요한데 이 저장소 범위 밖이라, 최소한 로그에서는 절대
  // 놓치지 않도록 형식만 통일해 눈에 띄게 한다.
  function logCronFailure(name, err) {
    console.error(`\n[크론 실패!!] ${name}\n  오류: ${err.message}\n  ${err.stack || ''}\n`);
  }

  // 결제 미완료 리스크 체크: 1시간마다
  const { checkPaymentOverdue, checkLowStock, createRisk } = require('./routes/risks');
  const runOverdueCheck = withOverlapGuard('결제 미완료 체크', async () => {
    try {
      const brands = await knex('brands').select('id');
      for (const b of brands) await checkPaymentOverdue(b.id);
    } catch (e) { logCronFailure('결제 미완료 체크', e); }
  });
  runOverdueCheck();
  // 반환값을 그냥 버리면 나중에 이 타이머를 멈출 방법이 없다 — graceful shutdown 시 clearInterval하기
  // 위해 참조를 모듈 스코프 변수에 보관한다.
  overdueInterval = setInterval(runOverdueCheck, 60 * 60 * 1000);

  // 재고 부족 리스크 체크: 10분마다 (재고부족 팝업과 별개로 리스크 알림 탭에도 쌓이도록)
  const runLowStockCheck = withOverlapGuard('재고 부족 체크', async () => {
    try {
      const brands = await knex('brands').select('id');
      for (const b of brands) await checkLowStock(b.id);
    } catch (e) { logCronFailure('재고 부족 체크', e); }
  });
  runLowStockCheck();
  lowStockInterval = setInterval(runLowStockCheck, 10 * 60 * 1000);

  // Toss Place 과거/누락 매출 자동 동기화: 토스플레이스 매장 ID가 등록된 가맹점만 3분마다 재동기화.
  // 배달앱 연동을 켠 매장은 배민/쿠팡이츠/요기요 주문도 이 동기화 하나로 같이 들어온다(channel로 구분됨) —
  // server/src/channels/toss.js 참고.
  // 한 번도 동기화 안 한 가맹점은 전체 매출(최근 5년)을, 이후엔 최근 2일치만 다시 가져옴 (API 호출량 보호)
  const { toss } = require('./channels');
  const { acquireStoreSyncLock, releaseStoreSyncLock } = require('./syncLock');

  // 가맹점별 토스 자동 동기화 연속 실패 횟수. 프로세스 메모리에만 두므로 서버가 재기동되면 0으로
  // 초기화되고, 인스턴스를 여러 개 띄우면 인스턴스마다 따로 센다 — 로그인 잠금/rate limit과 같은
  // 한계다(CLAUDE.md 6절). 이 크론이 3분마다 돌고(withOverlapGuard로 겹쳐 돌지는 않음) 실패해도
  // 다음 실행에서 자동으로 다시 시도하므로, 1~2회 실패는 대개 일시적 네트워크 오류나 토스 쪽 순간
  // 장애다 — 그때마다 알리면 알림이 무의미해진다. 반대로 임계값을 너무 높이면(예: 20회 = 1시간)
  // 그동안 매출이 안 들어와 재고 차감·재고부족 알림·발주 추천이 조용히 계속 틀어진 채로 방치된다.
  // 5회 연속(약 12~15분, withOverlapGuard로 실행이 밀리면 그보다 더 걸릴 수 있음)을 절충값으로 둔다.
  const syncFailureCounts = {};
  const SYNC_FAILURE_THRESHOLD = 5;

  const { computeSyncWindow, computeFailureOutcome, SYNC_MIN_WINDOW_MS } = require('./syncWindow');

  const runAutoSync = withOverlapGuard('토스 자동 동기화', async () => {
    try {
      const stores = await knex('stores').whereNotNull('toss_store_id').where('toss_store_id', '!=', '');
      // 예전 `to`는 UTC 날짜 문자열('YYYY-MM-DD')을 KST 23:59:59로 해석해서, KST 00:00~09:00
      // 사이에는 `to`가 실제 "지금"보다 최대 5시간 과거였다 — 자정 이후 판매가 다음날 오전 9시까지
      // 동기화 대상 구간 밖에 있었다. epoch ms를 직접 쓰면 이 변환 자체가 사라진다.
      const nowTs = Date.now();
      for (const store of stores) {
        // `from`/`to` 창 계산은 syncWindow.js로 옮겨 부수효과 없이 단독 테스트할 수 있게 했다
        // (아래 실패 판정도 마찬가지).
        const { fromTs, toTs, lastTs } = computeSyncWindow(store.last_synced_at, nowTs);

        // 수동 동기화(routes/api.js)와 이 크론이 같은 매장을 동시에 돌면 두 트랜잭션이 같은 주문을
        // 각각 "처음 보는 주문"으로 판단해 재고를 이중 차감/이중 복구할 수 있다 — DB 컬럼 하나에
        // 대한 조건부 UPDATE(syncLock.js)로 선점해 이를 막는다.
        const { ok, stamp } = await acquireStoreSyncLock(knex, store.id);
        if (!ok) { console.log(`[자동 동기화] ${store.name}: 다른 실행이 진행 중이라 건너뜀`); continue; }
        let abandonedFromIso = null; // 실패로 재시도 창이 앞으로 밀려 그 이전 구간을 포기했는지
        try {
          const result = await toss.syncStoreSales(store, fromTs, toTs);
          // 주문이 일부라도 실패하면 last_synced_at을 toTs까지는 밀지 않는다 — 예전엔 개수만
          // 반환받아 전량 실패해도 "성공"으로 보고 last_synced_at을 갱신했고, 그 구간 주문은
          // 다음 창(최근 2일)에서도 안 걸리면 영영 빠졌다.
          if (result.failed > 0) {
            const { retryFloorTs, advanced } = computeFailureOutcome(lastTs, toTs);
            if (advanced) {
              // 실패했는데도 재시도 창을 앞으로 미는 것은 "그 이전 구간을 포기한다"는 뜻이다. 5년 재스캔을
              // 막기 위해 이 전진 자체는 유지하되, 포기한 순간이 곧 사람이 알아야 하는 순간이므로 연속 실패
              // 임계(5회)와 무관하게 즉시 알린다 — 서버가 5일 멈췄다 살아나 4일 전 주문 1건이 실패하면
              // 그 구간이 다음 창(2일) 밖으로 밀려 영구 유실되는데, 1회 실패라 임계에도 안 걸렸다.
              abandonedFromIso = new Date(lastTs === null ? fromTs : lastTs).toISOString();
              await knex('stores').where({ id: store.id }).update({ last_synced_at: new Date(retryFloorTs).toISOString() });
            }
            throw new Error(`주문 ${result.failed}건 처리 실패 (성공 ${result.inserted}건)`);
          }
          // 조회에 실제로 쓴 상한(toTs)을 그대로 기록해야 다음 창 계산(위 fromTs)에 구멍이 안 생긴다.
          await knex('stores').where({ id: store.id }).update({ last_synced_at: new Date(toTs).toISOString() });
          syncFailureCounts[store.id] = 0; // 성공했으니 연속 실패 카운터 초기화
          // 변경 없는 upsert가 3분마다 전 매장에 대해 도는 낭비였다 — 이번 동기화로 실제 반영된
          // 주문이 있을 때만 store_integrations를 다시 채운다.
          if (result.inserted > 0) {
            try {
              await syncStoreIntegrations(knex, store.id);
            } catch (e) {
              console.error(`[store_integrations] ${store.name} 이중 기록 실패:`, e.message);
            }
            console.log(`[자동 동기화] ${store.name}: ${result.inserted}건 반영(스킵 ${result.skipped}) (${new Date(fromTs).toISOString()} ~ ${new Date(toTs).toISOString()})`);
          }
        } catch (e) {
          console.error(`[자동 동기화] ${store.name} 오류:`, e.message);
          const failCount = (syncFailureCounts[store.id] || 0) + 1;
          syncFailureCounts[store.id] = failCount;
          if (failCount >= SYNC_FAILURE_THRESHOLD || abandonedFromIso) {
            // createRisk는 knex(...)를 직접 호출한다 — 여기는 트랜잭션 밖이라 안전하다(트랜잭션 안에서
            // 부르면 SQLite 단일 커넥션 풀에서 교착 상태에 빠질 수 있음, CLAUDE.md 4절 참고).
            // 리스크 생성 자체가 실패해도 동기화 루프(다음 가맹점, 다음 크론 실행)는 계속 돌아야 하므로
            // 별도 try/catch로 감싼다.
            const description = abandonedFromIso
              ? `토스 매출 동기화 실패로 재조회 구간이 축소되었습니다: ${store.name} — ${abandonedFromIso} ~ ${new Date(toTs - SYNC_MIN_WINDOW_MS).toISOString()} 구간은 자동 재시도 대상에서 제외됩니다. 가맹점 화면의 '매출 동기화'로 해당 기간을 직접 조회해주세요 (오류: ${e.message})`
              : `토스 매출 동기화 연속 실패: ${store.name} — ${failCount}회 연속 실패 (마지막 오류: ${e.message})`;
            try {
              await createRisk(store.brand_id, store.id, RISK_TYPES.SYNC_FAILED, RISK_SEVERITIES.HIGH,
                description,
                { store_id: store.id, store_name: store.name, consecutive_failures: failCount, last_error: e.message,
                  abandoned_from: abandonedFromIso, abandoned_to: new Date(toTs - SYNC_MIN_WINDOW_MS).toISOString() });
            } catch (riskErr) {
              console.error(`[리스크] ${store.name} SYNC_FAILED 알림 생성 실패:`, riskErr.message);
            }
          }
        } finally {
          await releaseStoreSyncLock(knex, store.id, stamp);
        }
      }
    } catch (e) { logCronFailure('토스 자동 동기화', e); }
  });
  runAutoSync();
  autoSyncInterval = setInterval(runAutoSync, 3 * 60 * 1000);

  // 오래된 리스크/이력 데이터 정리: 1일마다 (무한 누적 방지)
  // - 처리 완료(RESOLVED/DISMISSED) 리스크는 180일 보관 후 삭제
  // - 발주 처리 이력(order_history)은 1년 보관 후 삭제 (분쟁/정산 추적 기간 고려)
  const runDataCleanup = withOverlapGuard('오래된 데이터 정리', async () => {
    try {
      // risk_alerts/order_history의 created_at, alert_log의 sent_at 모두 knex.fn.now() 기본값이다.
      // ISO 문자열(new Date().toISOString())로 비교하면 로컬(sqlite)에서는 저장 형식('YYYY-MM-DD
      // HH:MM:SS', UTC)과 형식이 달라 문자열 비교가 항상 어긋나 아무것도 안 지워지고 있었다 —
      // dbTime.js가 방언에 맞는 형식을 돌려준다.
      const riskCutoff = dbTimeAgo(180 * 86400000);
      const deletedRisks = await knex('risk_alerts')
        .whereIn('status', [RISK_STATUSES.RESOLVED, RISK_STATUSES.DISMISSED]).where('created_at', '<', riskCutoff).delete();
      const historyCutoff = dbTimeAgo(365 * 86400000);
      const deletedHistory = await knex('order_history').where('created_at', '<', historyCutoff).delete();
      // alert_log(재고부족 알림 1시간 중복 방지용)는 그 목적을 다하면 그냥 쌓이기만 하는 이력이다 —
      // 90일이면 어떤 재고부족 재발 패턴을 되짚어보기에 충분하고, 그 이상은 무한 누적만 된다.
      const alertCutoff = dbTimeAgo(90 * 86400000);
      const deletedAlerts = await knex('alert_log').where('sent_at', '<', alertCutoff).delete();
      if (deletedRisks || deletedHistory || deletedAlerts) {
        console.log(`[정리] 리스크 ${deletedRisks}건, 발주이력 ${deletedHistory}건, 알림로그 ${deletedAlerts}건 삭제`);
      }
    } catch (e) { logCronFailure('오래된 데이터 정리', e); }
  });
  runDataCleanup();
  dataCleanupInterval = setInterval(runDataCleanup, 24 * 60 * 60 * 1000);

  cronRunners = [runOverdueCheck, runLowStockCheck, runAutoSync, runDataCleanup];
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

// Graceful shutdown — 재배포/스케일 조정 시 플랫폼이 SIGTERM을 보내는데, 지금까지는 이를 그냥
// 흘려보내(기본 동작) 프로세스가 즉시 죽어 처리 중이던 요청이 잘리고 knex 커넥션 풀도 정리되지 않았다.
// 결제 승인·재고 트랜잭션이 한창 진행 중이었다면 데이터 정합성이 깨질 수 있다.
//
// 순서: 새 연결 수락 중단(server.close) → 진행 중인 요청 완료 대기(close 콜백) → 크론 타이머 정리
// → knex.destroy() → 프로세스 종료.
const SHUTDOWN_TIMEOUT_MS = 15000; // 10~30초 권장 범위 중, Render 등 배포 플랫폼이 SIGTERM 이후
// 강제 종료(SIGKILL)까지 주는 유예 시간이 보통 수십 초 안팎이라 그 안에서 여유 있게 자체 종료하도록 15초로 잡는다.

function gracefulShutdown(signal) {
  // SIGTERM 이후 SIGINT가 또 오는 등 종료 신호가 두 번 이상 들어와도 정리 로직이 중복 실행되지
  // 않도록 가드한다 (중복 실행되면 knex.destroy()가 두 번 불리는 등 예측 못한 오류로 이어질 수 있음).
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[종료] ${signal} 수신 — graceful shutdown을 시작합니다`);

  // 무한정 기다리지 않는다 — 진행 중인 요청이나 knex.destroy()가 예상보다 오래 걸려도, 배포 플랫폼이
  // 정해둔 강제 종료 시점 전에 스스로 끝내야 다음 배포/스케일 조정이 그만큼 밀리지 않는다.
  const forceExitTimer = setTimeout(() => {
    console.error(`[종료] ${SHUTDOWN_TIMEOUT_MS}ms 안에 정상 종료하지 못해 강제 종료합니다`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  const finish = async (code) => {
    // 진행 중이던 요청이 다 끝난 뒤에 크론 타이머를 멈추고 DB 커넥션을 정리한다.
    clearInterval(overdueInterval);
    clearInterval(lowStockInterval);
    clearInterval(autoSyncInterval);
    clearInterval(dataCleanupInterval);

    // 타이머를 멈춰도 이미 시작된 크론 실행(재고 트랜잭션이 한창일 수 있다)은 즉시 끝나지 않는다.
    // knex.destroy()가 그 트랜잭션의 커넥션을 끊어버리면 트랜잭션이 어중간하게 남을 수 있어,
    // 최대 5초까지 폴링으로 기다린다 — 그 이상은 위 forceExitTimer가 어차피 강제 종료로 정리한다.
    const CRON_WAIT_TIMEOUT_MS = 5000;
    const deadline = Date.now() + CRON_WAIT_TIMEOUT_MS;
    while (cronRunners.some(r => r.isRunning()) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    knex.destroy()
      .catch(e => console.error('[종료] knex.destroy() 오류:', e.message))
      .finally(() => {
        clearTimeout(forceExitTimer);
        console.log('[종료] 정리를 마치고 프로세스를 종료합니다');
        process.exit(code);
      });
  };

  if (server) {
    // server.close()는 새 연결 수락을 중단하고, 이미 열려 있던 연결(진행 중인 요청)이 전부 끝나면
    // 콜백을 호출한다 — "진행 중인 요청 완료 대기"를 이 콜백으로 구현한다.
    server.close((err) => {
      if (err) console.error('[종료] server.close() 오류:', err.message);
      finish(0);
    });

    // SSE(routes/sse.js)는 클라이언트가 몇 시간~며칠씩 연결을 붙잡고 있는 구조라, server.close()의
    // 기본 동작("열려 있던 연결이 전부 끝날 때까지 대기") 그대로 두면 SSE 클라이언트가 스스로 끊기
    // 전까지는 절대 위 콜백이 안 불려서 매번 강제 종료 타임아웃까지 흘러가버린다. 결제/발주처럼
    // 실제로 끝까지 기다려야 하는 짧은 요청들은 이 유예 시간 안에 대부분 끝나므로, 그 뒤에 남아있는
    // 연결(대부분 SSE)만 강제로 끊어 server.close() 콜백이 불릴 수 있게 한다. EventSource는 연결이
    // 끊기면 브라우저가 알아서 재연결하므로 클라이언트 쪽 데이터 유실은 없다.
    const SSE_GRACE_MS = 5000;
    const sseGraceTimer = setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') {
        console.log('[종료] 유예 시간 이후 남은 연결(주로 SSE)을 강제로 종료합니다');
        server.closeAllConnections();
      }
    }, SSE_GRACE_MS);
    sseGraceTimer.unref(); // forceExitTimer가 이미 상한선을 보장하므로 이 타이머가 별도로 프로세스를 붙잡을 필요는 없음
  } else {
    // initDb()가 끝나기 전에(= app.listen 호출 전에) 신호를 받은 경우 — 정리할 서버가 없으므로
    // 바로 마무리 단계로 넘어간다.
    finish(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
