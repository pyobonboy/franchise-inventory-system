# 아키텍처와 설계 노트 — 프랜차이즈 재고·발주 관리 시스템

소스 주석의 "CLAUDE.md N절" 참조는 이 문서의 같은 번호 절을 가리킨다. 코드에서 확인한 사실만 담는다.

## 1. 이 프로젝트가 무엇인가

본사(HQ)와 가맹점(Store) 사이의 재고·발주·매출을 관리하는 시스템이다. 전체 사이클은 대략 이렇다:

1. **POS 매출 유입** — **주 경로는 3분마다 도는 폴링**이다(`server/src/index.js`의 `runAutoSync` → `server/src/channels/toss.js`). 주문 원본은 `orders`에, 메뉴별 판매는 `sales_items`에 저장되고, 레시피(`recipes`)를 따라 재료(`ingredients`) 재고가 차감된다.
   - **반영 로직은 `server/src/salesIngest.js` 하나뿐이다.** 폴링과 웹훅이 같은 함수(`ingestCompletedOrder`/`reverseCancelledOrder`)를 쓴다. 예전엔 재고 차감이 웹훅 경로에만 있어서, 웹훅을 등록하지 않은 가맹점은 매출만 쌓이고 재고가 영영 안 줄어드는 문제가 있었다.
   - **웹훅(`server/src/routes/webhook.js`)은 이제 선택 사항이다.** 토스 주문 조회 API는 `from`/`to`가 "결제 내역이 **변동된** 시각" 기준이고 `orderStates` 기본값이 `["COMPLETED","CANCELLED"]`라, 취소도 폴링으로 내려온다(예전 코드가 `orderStates=COMPLETED`로 좁혀놔서 취소가 안 내려왔고, 그 구멍 때문에 웹훅이 필수였다). 실제 토스 연동으로 폴링이 검증될 때까지 웹훅을 남겨둔 상태이며, 확인되면 배선을 제거할 예정이다.
   - **폴링은 같은 주문을 3분마다 다시 본다.** 그래서 중복 반영 방지가 이 경로의 핵심이다 — 이미 `COMPLETED`로 반영된 주문은 주문행만 갱신하고 재고는 건드리지 않고, 취소는 **저장된 상태가 `COMPLETED`였을 때만** 되돌린다(처음부터 취소인 주문을 복구하면 판 적 없는 재료가 늘어난다). 이 경로를 고칠 때 반드시 지킬 것. 중복 방지는 존재 확인 `SELECT`가 아니라 `order_state` 조건부 `UPDATE`의 영향 행 수로 소유권을 선점하는 방식이다(`INGESTING`→`COMPLETED`, `COMPLETED`→`CANCELLED`) — 웹훅과 폴링이 동시에 같은 주문을 봐도 Postgres에서 두 트랜잭션이 같은 값을 읽고 함께 재고를 이중 차감/이중 복구하는 사고가 나지 않는다. 이 선점 `UPDATE`와 이어지는 조회는 전부 **`store_id` 조건을 함께 건다**(`toss_order_id`만으로 찾지 않는다) — 같은 `toss_order_id`가 다른 가맹점에 이미 있을 가능성을 배제하지 못하면 엉뚱한 가맹점의 재고를 건드리게 된다. 소유권을 판정할 수 없는 경우(우리 `store_id`로는 행이 안 보이는데 전역으로는 존재, 혹은 예상 밖 `order_state`)는 조용히 넘어가지 않고 `throw`하며, 호출부(`processOneOrder`)가 이를 잡아 `failed`로 집계한다. `order_state`가 `NULL`인 레거시 행(컬럼 도입 이전에 들어온 주문)은 별도 치유 분기가 있어 재차감 없이 `COMPLETED`로 승격만 시킨다(`salesIngest.js`). **알려진 한계**: `orders.toss_order_id`는 아직 전역 `UNIQUE`다. `(store_id, toss_order_id)` 복합 `UNIQUE`로 바꾸는 것이 근본적인 해결이지만, sqlite에서 `UNIQUE` 제약 변경은 `orders` 테이블 전체 재생성을 요구해 별도 작업으로 미뤘다 — 지금은 위 애플리케이션 레벨 `store_id` 조건으로만 막고 있다.
   - **폴링 시간창은 `to = now`, `from = min(직전 동기화 시각 - 10분, now - 2일)`로 계산된다**(`server/src/index.js`의 `runAutoSync`) — 직전 동기화 이후 얼마 안 지났어도 최소 2일치 창은 항상 다시 훑어 경계 누락을 막고, 오래 정지했다 재개해도 그 최소 창은 보장된다. 최초 동기화(한 번도 동기화한 적 없는 가맹점)만 예외로 최근 5년 전체를 가져온다. 계산은 `server/src/syncWindow.js`의 순수 함수 2개(`computeSyncWindow`, `computeFailureOutcome`)에 있다 — 원래 `runAutoSync` 안에 인라인이라 테스트가 불가능했던 것을 부수효과 없이 뽑아낸 것뿐, 파일 분리 리팩터링이 목적은 아니다. 동기화 실패 시 `last_synced_at`을 `now - 2일`까지는 전진시킨다(그 이전 구간은 이미 지난 실행들이 봤다고 간주). **이 전진이 실제로 일어나면(재시도 창이 앞으로 밀려 그 이전 구간을 포기했다는 뜻) 연속 실패 횟수와 무관하게 즉시 `SYNC_FAILED` 리스크를 만든다** — 5회를 채우길 기다리면 그 사이 못 본 구간이 영구 유실되기 때문이다. 수동 동기화(`POST /api/stores/:id/sync`)와 이 크론이 같은 매장을 동시에 돌면 두 트랜잭션이 같은 주문을 각각 "처음 보는 주문"으로 판단해 재고가 이중 차감/이중 복구될 수 있어, `stores.sync_locked_at` 컬럼에 대한 조건부 UPDATE(`server/src/syncLock.js`의 `acquireStoreSyncLock`/`releaseStoreSyncLock`, TTL 30분)로 크론과 수동 동기화가 같은 락을 공유한다.
   - **취소된 주문이 나중에 다시 `COMPLETED`로 내려오면 건너뛴다** — 저장된 `orders.order_state`가 이미 `CANCELLED`인 주문은 재반영(재고 재차감)하지 않고 경고 로그만 남긴다(`salesIngest.js`의 `ingestCompletedOrder`). 재반영을 허용하면 폴링이 같은 창에서 취소/완료를 번갈아 보일 때마다 재고가 계속 흔들린다.
   - 가맹점에 `stores.toss_store_id`(토스플레이스 merchantId)가 없으면 `runAutoSync` 대상에서 아예 빠진다 — 매출도 재고도 사입 감시도 전부 안 도는데 화면은 멀쩡해 보인다. 가맹점 온보딩에서 가장 중요한 값이다.
2. **재고 부족/리스크 감지** — 크론(`server/src/index.js`)이 10분마다 재고 부족을, 1시간마다 결제 미완료를 점검해 `risk_alerts`에 기록한다(`server/src/routes/risks.js`).
   - `risk_alerts`는 **장사 리스크만이 아니라 "시스템이 제 역할을 못 하고 있다"는 신호도 함께 담는다**(`constants.js`의 `RISK_TYPES`, 총 14종 중 뒤쪽 6개). `MENU_UNMATCHED`(POS 메뉴명이 등록 메뉴와 안 맞거나 레시피가 없어 재고가 차감되지 않음), `NEGATIVE_STOCK`(재고가 음수), `WEBHOOK_REJECTED`(웹훅 거부로 매출 유입 중단), `SYNC_FAILED`(토스 동기화 실패로 `last_synced_at`이 전진, 위 1절 참고), `REFUND_INCONSISTENT`(토스 환불은 성공했으나 DB 반영 트랜잭션이 실패해 수동 대사가 필요), `SALES_REINGEST_BLOCKED`(취소 처리된 주문이 다시 `COMPLETED`로 내려와 재반영을 차단함). 이런 실패는 예전엔 console 로그로만 남아 아무도 안 봤고, 그 사이 재고·매출 데이터가 조용히 틀어졌다.
   - 새 알림 수단을 만들지 말고 이 체계에 얹을 것 — 운영자가 이미 보는 화면에 떠야 실제로 눈에 들어온다. 단, `client/src/pages/Risks.jsx`의 `TYPE_LABEL`에 새 타입의 한국어 라벨을 추가하지 않으면 화면에 타입 문자열이 그대로 노출된다(폴백은 있어 깨지지는 않음).
   - **`createRisk`는 절대 트랜잭션 안에서 호출하지 말 것** — 내부에서 `knex`(비트랜잭션 커넥션)를 쓰므로 교착에 빠진다(아래 4절). 트랜잭션 안에서는 알릴 내용만 모아뒀다가 커밋 후에 호출한다(`webhook.js`의 `emitRiskNotifications` 참고).
   - 중복 방지는 (브랜드, 가맹점, 타입) 단위다. 미해결 알림이 있으면 새로 만들지 않고 설명만 갱신하므로, **같은 타입의 새로운 사례는 별도 신호 없이 기존 알림에 흡수된다**는 점을 알고 있을 것.
3. **가맹점 발주** — 가맹점이 `products`(발주 상품) 카탈로그에서 담아 발주서(`purchase_orders` + `purchase_order_items`)를 만든다. 상태는 `server/src/constants.js`의 `ORDER_STATUSES` 순서(아래 3절)를 따라 흐른다.
4. **본사 검수·결제·배송** — 본사가 수량 조정/품절 처리를 하면 가맹점에 `needs_attention` 플래그로 알린다. 결제는 토스페이먼츠 연동(`purchase_orders.toss_order_code`/`toss_payment_key`)으로 이뤄진다.
5. **납품·수령확인** — `DELIVERED` 처리 시 재료 재고가 자동으로 늘어나고(`server/src/routes/orders.js`의 `applyDeliveryStock`), 가맹점이 실제로 받은 게 맞는지 확인하는 수령확인(`receipt_confirmed_at`, `receipt_issue_note`) 절차가 있다.

재료 재고를 바꾸는 경로는 전부 `stock_ledger`(수불부)에 남도록 맞춰져 있다: 판매/판매취소(`salesIngest.js`의 `adjustStock`, `SALE`/`SALE_CANCEL`), 납품/환불(`orders.js`의 `applyItemStock`, `DELIVERY`/`REFUND`), 폐기/폐기취소(`waste.js`, `WASTE`/`WASTE_CANCEL`), 실사조정(`stock.js`의 `POST /adjustments`, `ADJUSTMENT`), 간편 입고(`api.js`의 `POST /ingredients/:id/restock`, `DELIVERY`), 재료 직접 수정으로 재고가 바뀔 때(`api.js`의 `PUT /ingredients/:id`, `ADJUSTMENT`, 재고값이 실제로 달라질 때만). 전부 재고 변경과 같은 트랜잭션 안에서 `logStockMovement`를 호출해, 기록이 실패하면 재고 변경도 함께 롤백된다.
   - 예외: `POST /ingredients`(재료 신규 등록)로 초기 재고를 넣는 경우는 수불부에 남지 않는다 — 이전 상태가 없는 신규 행 생성이라 "변동"으로 보기 애매해 의도적으로 뺐지만, 그 값도 실제 재고 수치에는 반영되므로 완전한 무결점은 아니다.

## 2. 아키텍처

- **서버**: `server/` — Express + Knex. 로컬은 SQLite(`server/data.db`), 운영은 Postgres(`DATABASE_URL` 존재 여부로 `isProduction` 판별, `server/src/db/schema.js:1`). 진입점은 `server/src/index.js` — CORS 설정, 라우터 마운트, 크론 잡(결제 미완료 체크·재고 부족 체크·토스 자동 동기화·오래된 데이터 정리)이 전부 여기 있다.
- **운영 관련 장치** (전부 `server/src/index.js`와 `server/src/middleware/`):
  - `GET /health` — 인증 없이 접근 가능. DB에 실제로 붙는지 확인해서 실패 시 503. 종료 중에도 503(로드밸런서가 새 요청을 안 보내도록).
  - **Graceful shutdown** — SIGTERM/SIGINT에서 새 연결 중단 → 진행 중 요청 대기 → 크론 타이머 정리 → `knex.destroy()`. SSE는 연결을 며칠씩 붙잡으므로 5초 유예 후 남은 연결을 강제로 끊어야 정상 종료 경로를 탄다(안 그러면 매번 강제 종료 타임아웃까지 흘러간다).
  - `middleware/requestLog.js` — 요청 1건당 한 줄. **쿼리스트링을 통째로 잘라낸다** — `/sse`가 JWT를 `?token=`으로 받기 때문에 URL을 그대로 로깅하면 토큰이 로그에 남는다. 바디도 절대 로깅하지 않는다.
  - `middleware/rateLimit.js` — IP당 분당 300건. **토스 웹훅(`/webhook/*`, `/api/orders/toss-webhook`)과 `/health`는 제외** — 웹훅이 429로 막히면 토스가 무한 재시도하지 않아 매출이 유실된다. `app.set('trust proxy', 1)`이 없으면 프록시 뒤에서 전원이 IP 하나로 묶인다.
  - 요청 크기: 웹훅 raw body 256kb(서명 검증 전에 바디를 다 읽으므로 무제한이면 인증 없이 메모리 고갈 가능), `express.json()` 1mb.
- **클라이언트**: `client/` — React + Vite + Tailwind v4(`@tailwindcss/vite`) + Radix(`radix-ui`). 라우팅/레이아웃은 `client/src/App.jsx`에서 역할에 따라 `HQLayout`(본사)과 `StoreLayout`(가맹점)으로 완전히 분리된다(`AppRoutes` 함수 참고).
- **배포**: `render.yaml` — 서버(`inventory-alert-server`, Postgres 연결), 클라이언트(정적 사이트), DB(`inventory-db`, Postgres) 3개 서비스. 서버 `CLIENT_URL` 환경변수를 운영에서 반드시 설정해야 CORS가 뚫린다(비우면 프론트 요청 전부 차단, 대시보드에서 직접 입력 — `sync: false`).
- **로컬 실행**: 루트의 `시작.bat`이 백엔드(`node src/index.js`)·프론트(`npm run dev -- --host`)·Cloudflare Quick Tunnel 2개(백엔드/프론트 각각)를 한 번에 띄운다. 개별 실행은 `server`에서 `npm run dev`(nodemon), `client`에서 `npm run dev`(vite).

## 3. 핵심 도메인 개념

**재료 → 메뉴 → 레시피 → 자동 재고 차감**
- `ingredients`(재료), `menus`(메뉴)는 각각 `brand_id`+`store_id`로 가맹점별로 존재한다.
- `recipes`(menu_id, ingredient_id, amount)가 메뉴 1개당 재료 소모량을 정의한다.
- 판매가 들어오면(`salesIngest.js`의 `adjustStock`) 메뉴명/`toss_menu_id`로 메뉴를 찾고, 그 메뉴의 레시피를 순회하며 재료 `stock`을 차감하고 `stock_ledger`에 `SALE` 타입으로 기록한다. 취소는 반대(`SALE_CANCEL`).

**발주 상태 흐름** (`server/src/constants.js`의 `ORDER_STATUSES`, 정의된 순서 그대로가 실제 흐름):
```
DRAFT(임시저장) → ORDERED(발주) → REVIEWING(본사검토) → REVISION_REQUESTED(수정요청)
  → CONFIRMED(확정) → PAYMENT_PENDING(결제대기) → PAID(결제완료)
  → PREPARING_SHIPMENT(배송준비) → SHIPPED(배송중) → DELIVERED(납품완료) → CLOSED(종료)
(PAID 이전 모든 단계에서 CANCELED 가능. PAID 이후는 CANCELED로 전이할 수 없다 — 아래 참고)
```
`DELIVERED` 시점에 재고가 자동 반영되고(`stock_applied` 플래그로 중복 반영 방지), 환불 시 `stock_reversed` 플래그로 재고 원복 여부를 추적한다.

허용 전이는 `server/src/orderStatusFlow.js`의 `ALLOWED_TRANSITIONS`가 정본이고, 클라이언트 `client/src/constants/orderStatus.js`의 `NEXT_STATUSES`가 그 사본이다 — 한쪽만 고치면 화면과 서버가 어긋난다. **`PAID` 이후 → `CANCELED` 전이는 표에서 의도적으로 뺐다** — 결제 완료 발주서를 상태변경 API로 취소하면 토스 환불 없이 `status`만 `CANCELED`가 되어 정산(`/settlement`, `paid_at` 기준)에는 매출로 계속 남고 재고 원복도 일어나지 않는다. 결제 후 취소는 `POST /:id/refund`(전액 환불)만이 정당한 경로이고, 그 라우트는 전이표를 거치지 않고 직접 `status: CANCELED`를 쓴다. 취소 가능 여부 판정은 `server/src/routes/orders.js`의 `cancelBlockReason(order)` **하나가 정본**이고 `DELETE /:id`와 `POST /:id/status`가 이 함수를 함께 쓴다(취소 불가 상태거나 이미 결제된 발주서면 문자열 사유를 400으로 그대로 응답).

**금액 계산**: `purchase_orders.confirmed_amount`와 `purchase_order_items.amount`는 `server/src/routes/orders.js`의 `recalcOrderAmounts(trx, orderId)` **한 곳에서만** 계산된다(품목 상태/확정수량이 바뀌는 모든 경로가 이 함수를 거친다). 품목 `status`가 `OUT_OF_STOCK`이면 그 품목 금액은 0으로 친다. `PUT /:id`(품목 교체)는 재계산이 아니라 `confirmed_amount: null` 리셋이다 — 품목이 통째로 바뀌므로 본사가 다시 검토·확정해야 하는 상태로 되돌리기 위함이다.

**역할 6종과 권한 경계** (`server/src/middleware/auth.js`):
| 역할 | 그룹 | 비고 |
|---|---|---|
| `SUPER_ADMIN`, `HQ_ADMIN` | `ADMIN_ROLES` | 가맹점 정보·사용자 관리 |
| `SUPER_ADMIN`, `HQ_ADMIN`, `HQ_LOGISTICS` | `LOGISTICS_ROLES` | 발주 상태변경, 상품/재료/메뉴 관리 (회계는 조회만) |
| `SUPER_ADMIN`, `HQ_ADMIN`, `HQ_LOGISTICS`, `HQ_ACCOUNTING` | `HQ_ROLES` | 본사 공통 |
| `STORE_OWNER`, `STORE_STAFF` | `STORE_ROLES` | 가맹점 |

토큰(JWT)에는 `id`, `role`, `brand_id`, `store_id`가 들어가고, `requireAuth`가 매 요청마다 `users.is_active`를 DB에서 다시 확인한다(토큰만으로는 비활성화 여부를 알 수 없어서).

## 4. 함정과 주의사항

- **`toss_` 접두사가 서로 다른 3가지를 가리킨다.** `server/docs/db-schema-review.md`(3번 항목)에 정리되어 있음:
  - `stores.toss_client_id`/`toss_client_secret`/`toss_api_key` → **토스페이먼츠**(발주 대금 결제)
  - `stores.toss_store_id`, `TOSS_PLACE_ACCESS_KEY`/`TOSS_PLACE_SECRET_KEY` → **토스플레이스**(POS 매출 조회)
  - `orders.toss_order_id`, `sales_items.toss_order_id`/`toss_menu_id` → 지금은 토스플레이스뿐 아니라 배민/쿠팡이츠/요기요까지 포괄하는 **범용 식별자**(`channel` 컬럼으로 실제 출처 구분). 새 필드를 추가할 땐 `toss_place_*`/`toss_payments_*`로 제품을 명확히 구분할 것.
- **스키마가 이원화되어 있다.** `server/src/db/schema.js`의 `initDb()`(레거시, `createIfMissing`/`addColumnIfMissing` 패턴으로 서버 기동마다 스키마를 다시 훑음)와 `server/migrations/`(2026-08-25 `20260825000000_baseline.js` 이후 버전 관리되는 Knex 마이그레이션)로 나뉜다. `initDb()`가 먼저 끝난 뒤 `knex.migrate.latest()`가 실행된다(`schema.js` 마지막 부분). **앞으로의 스키마 변경은 반드시 마이그레이션 파일로 추가**하고 `initDb()`는 손대지 않는 것이 원칙(`server/migrations/README.md`). `npm run migrate:make -- <name>`으로 생성.
- **배달앱(배민/쿠팡이츠/요기요)은 별도 API가 없다.** 토스플레이스 동기화 하나가 가져오는 주문의 `order.source` 값을 그대로 `orders.channel`/`sales_items.channel`에 저장해서 채널을 구분한다(`server/src/channels/toss.js` 상단 주석). 배달앱 채널을 잘못 이해해서 `stores`에 `baemin_store_id` 같은 컬럼을 추가했다가 되돌린 이력이 있다(`server/docs/db-schema-review.md` 1번 항목) — 새 채널 연동을 만들 필요가 없다는 점을 먼저 인지할 것.
- **웹훅은 가맹점별 `webhook_secret`이 없으면 거부된다.** 과거엔 시크릿이 비어있으면 서명 검증 자체를 건너뛰어 누구나 URL의 `store_id`만 알면 가짜 주문을 보낼 수 있는 구멍이 있었고(커밋 `96f73ca`, `d1da066`), 지금은 시크릿이 없으면 경고 로그를 남기고 401로 거부한다(`server/src/routes/webhook.js`). 다만 **이제 이건 매출 유입을 막지 않는다** — 폴링이 주 경로이므로 시크릿 누락은 그 가맹점의 웹훅만 거부될 뿐이다(1절 참고). 서명 형식은 토스 문서와 대조해 일치를 확인했다: `HMAC-SHA256(secret, "{x-toss-timestamp}.{rawBody}")`를 hex로 인코딩하고 `v1=` 접두사를 붙인 값이 `x-toss-signature`와 같아야 하며, 타임스탬프는 epoch **밀리초**다.
- **자격증명 컬럼은 평문/암호문이 한 DB에 섞여 있을 수 있다.** `server/src/crypto.js`는 값이 `enc:v1:` 접두사로 시작하는지로만 판별한다(`isEncrypted`) — 접두사 없으면 무조건 평문으로 간주. 관리자 조회 API는 복호화해서 평문으로 내려주므로, 그 값을 그대로 다시 저장(왕복)해도 `encryptCredential`이 다시 접두사를 붙여 암호화할 뿐 이중 암호화(암호문을 또 암호화)는 되지 않는다 — 이중 암호화는 오직 이미 `enc:v1:`이 붙은 값을 판별 없이 다시 `encryptCredential`에 넣을 때만 발생하며, 마이그레이션/백필 모두 `isEncrypted` 체크로 이를 막는다.
- **`schema.js`에 로컬 전용 비밀번호 일괄 초기화 코드가 있다.** `initDb()`가 매 기동마다 `STORE_OWNER`/`STORE_STAFF` 전원의 비밀번호를 로컬 기본 비밀번호로 되돌린다 — 테스트 편의용으로 의도적으로 남겨뒀고, `isProduction`이면 건너뛴다(가드 없으면 운영 DB 실제 비밀번호가 서버 재기동마다 초기화되는 사고가 났었음, 커밋 `d7d8a0b`).
- **SQLite는 knex 커넥션 풀이 1개뿐이라, 이미 열린 트랜잭션 안에서 `trx(...)` 대신 `knex(...)`를 쓰면 서로 커넥션을 기다리며 교착 상태에 빠질 수 있다.** `server/src/salesIngest.js`의 `adjustStock`은 이 문제를 원천 차단하기 위해 `trx`를 폴백 없는 필수 인자로 받는다. `server/src/routes/orders.js`의 `applyDeliveryStock`/`applyItemStock`도 `trx = knex` 기본값 패턴으로 트랜잭션 안팎 모두에서 안전하게 쓰이도록 설계되어 있다 — 새 코드에서 트랜잭션 안에 있다면 반드시 그 `trx`를 그대로 전달해야 한다.
- **`stores.toss_api_key`는 deprecated 컬럼이지만 남아있다.** SQLite는 `DROP COLUMN` 시 테이블 전체를 재생성해야 해서(`dropColumnIfExists`, `server/src/db/schema.js`) 실데이터가 있는 상태에서 함부로 지우면 손상 위험이 있어 의도적으로 방치되어 있다.
- **컬럼/FK를 건드리는 마이그레이션에는 반드시 `exports.config = { transaction: false }`를 붙일 것.** 안 붙이면 knex가 `PRAGMA foreign_keys=OFF`를 걸지 못해, sqlite가 컬럼 변경 때문에 테이블을 재생성하는 동안 자식 테이블이 CASCADE로 전멸한다(`20260825030000_menu_recipe_extensibility.js`에서 실제로 겪은 사고, 규칙은 `server/migrations/README.md`에 정리). 순수 인덱스 추가만 하는 마이그레이션은 필요 없지만 애매하면 붙이는 쪽이 안전하다.
- **`knex.fn.now()`가 기본값인 컬럼과 시각을 비교할 땐 반드시 `server/src/dbTime.js`(`toDbTime`/`dbNow`/`dbTimeAgo`/`dbStartOfKstToday`)를 쓸 것.** `alert_log.sent_at`, `stock_ledger.created_at`, `risk_alerts.created_at`, `order_history.created_at`, `purchase_orders.created_at`처럼 DB가 채우는 컬럼은 sqlite에서 `'YYYY-MM-DD HH:MM:SS'`(UTC) 형식으로 저장되는데, `new Date().toISOString()`과 문자열로 직접 비교하면 항상 거짓이 된다(운영 Postgres는 timestamptz라 멀쩡히 동작해서 로컬에서만 조용히 틀린다). 반대로 `orders.processed_at`/`purchase_orders.paid_at`처럼 애플리케이션이 ISO 문자열을 직접 넣는 컬럼에는 쓰지 말 것 — 오히려 형식이 어긋난다. **이 프로젝트의 "오늘"은 항상 KST다** — 운영 서버 TZ가 UTC면 서버 로컬 자정은 KST와 9시간 어긋난다. 이 규칙에 맞춰 "오늘 자정" 헬퍼 이름도 KST 기준임을 드러내도록 `dbStartOfKstToday`로 명명되어 있고(호출부는 로컬 자정이 아니라 KST 자정을 기대하므로), `api.js`에 있던 `kstDayRange`(날짜 하나를 KST 하루의 시작/끝 UTC ISO로 변환)도 이 파일로 옮겨와 `dbStartOfKstToday`가 그 위에서 재구현되어 있다. `/analytics`의 일별 매출 버킷도 같은 이유로 DB 쿼리 단에서 KST로 자른다(`AT TIME ZONE 'Asia/Seoul'`(Postgres) / `datetime(sold_at, '+9 hours')`(sqlite)) — 값 하나를 JS로 당겨와 자르는 게 아니라 방언별 SQL 표현식이 갈린다.
- **환불은 토스를 부르기 전에 `refunded_amount` 조건부 UPDATE로 먼저 선점한다.** `server/src/routes/orders.js`의 `claimRefundAmount(orderId, expectedRefunded, nextRefunded)`가 `refunded_amount = expectedRefunded`인 행만 골라 갱신하고, 갱신 행 수가 1이 아니면(동시에 다른 환불 요청이 먼저 선점) 409로 거부한다. 순서를 뒤집어 토스 API를 먼저 부르면 동시 요청 두 개가 토스에 취소를 각각 요청해 실제로 2회 환불이 나간다. 토스 호출이 실패하면 `releaseRefundClaim`으로 선점을 되돌린다.
- **`resolveItemPrices`(`server/src/routes/orders.js`)는 `product_id`가 없는 발주 라인을 전부 거부한다.** 모든 라인이 `products` 테이블의 실제 상품 ID를 가리켜야 하고, 단가/단위는 서버가 그 상품 행에서 다시 조회해 채운다 — 클라이언트가 보낸 단가·단위를 그대로 믿는 발주 생성/수정 경로는 더 이상 없다.

## 5. 코드 컨벤션

- 이 저장소의 주석은 **"무엇을 하는지"가 아니라 "왜 이렇게 짰는지, 어떤 버그를 막기 위함인지"**를 한국어로 설명한다. 예:
  - `server/src/routes/risks.js`의 `createRisk`: `status`가 `'OPEN'`일 때만 중복 체크하면 안 되는 이유("담당자가 확인(ACKNOWLEDGED)만 하고 아직 해결 전인 상태에서 주기 점검이 다시 돌 때 '기존 알림 없음'으로 오판해 똑같은 건으로 새 알림이 하나 더 생겨버린다")를 설명하고 있다.
  - `server/src/index.js`의 CORS 설정: `CLIENT_URL`이 스킴 없이 들어올 수 있는 이유(`render.yaml`에 호스트명만 넣기 쉬움)와, 그걸 보정하지 않으면 벌어지는 구체적 증상("운영 프론트엔드가 전부 CORS 차단된다")까지 적혀 있다.
- 커밋 메시지도 한국어이며 `fix:`/`feat:`/`refactor:` 접두사를 쓴다 (`git log --oneline` 참고).

## 6. 알려진 미완 항목

- **테스트: `server/test/`에 Node 내장 `node:test` 기반 스위트가 있다 (jest/mocha/supertest 등 별도 의존성 없음).**
  - 실행: `server`에서 `npm test` (`node --test test/*.test.js`). `.github/workflows/ci.yml`이 push/PR마다 Node 20으로 서버 테스트를 **sqlite 잡(`server-test`)과 Postgres 잡(`server-test-postgres`, `postgres:16` 서비스 컨테이너) 두 개로 각각** 돌리고, 클라이언트 빌드(`npm run build`)도 별도 잡으로 확인한다 — `forUpdate()`/`to_char`/timestamptz 비교처럼 방언별로만 갈리는 버그가 sqlite 잡 하나로는 안 드러나서 추가되었다.
  - **`DATABASE_FILE` 환경변수**: 각 테스트 파일은 `server/test/helpers.js`를 require하기 전에 자기만의 임시 sqlite 파일 경로를 `process.env.DATABASE_FILE`로 지정한다 (`knexfile.js`의 sqlite `connection.filename`이 이 값을 우선한다). `helpers.js`는 `DATABASE_FILE`이 없으면 즉시 throw하는 가드를 갖고 있다 — 예전에 하던 대로 `require.cache`를 조작해 knexfile을 바꿔치기하지 않고도, 테스트가 실제 개발 DB(`server/data.db`)를 절대 건드리지 않게 하기 위함이다. **`node --test`가 파일마다 별도 프로세스로 실행되어 파일별 DB가 분리되는 건 sqlite 잡(`server-test`)에서만 참이다** — pg 잡(`server-test-postgres`)은 15개 파일이 `DATABASE_URL` 하나(같은 Postgres 인스턴스)를 공유하므로, `migrations.test.js`가 마이그레이션을 down하는 동안 다른 파일이 그 컬럼에 INSERT하는 식으로 비결정적으로 깨질 수 있어 `npm run test:serial`(`node --test --test-concurrency=1`, `server/package.json`)로 직렬 실행한다. 그리고 `helpers.js`는 `DATABASE_URL`이 설정된 채로 실행되면 테스트용 Postgres 허용 플래그(`server/test/helpers.js` 참고, CI의 `server-test-postgres` 잡이 설정)가 함께 없는 한 즉시 throw한다 — 셸에 스테이징 `DATABASE_URL`이 남은 채 `npm test`를 돌려 실제 DB의 마이그레이션을 down시키는 사고를 막기 위함이다(CI의 pg 잡은 이 값을 명시적으로 세팅).
  - **커버 범위**: 웹훅 서명 검증(`webhook.test.js`), 판매 재고 차감 트랜잭션 — 다중 라인 재고 차감/재전송 방지/취소 복구/**롤백**(`stock-transactions.test.js`, `stock_ledger` 테이블을 일시적으로 rename해서 트랜잭션 중간 실패를 강제하는 방식으로 검증), 결제 승인·환불과 `payments` 테이블 기록(`payments.test.js`, 토스 API는 `global.fetch` 모킹), 로그인 잠금·권한 역전 방어(`auth.test.js`), SSE 브랜드/가맹점별 권한 필터링(`sse.test.js`). 전부 내부 함수를 직접 부르지 않고 express 라우터에 실제 HTTP 요청을 보내는 방식(HTTP 계층 테스트)이다.
  - **신규 파일**: 발주 상태전이 허용/거부(`order-status-flow.test.js`, `orderStatusFlow.js`의 `ALLOWED_TRANSITIONS`), 발주 관련 권한 경계 — `GET /api/store-rankings` 같은 HQ 전용 엔드포인트와 `GET /api/dashboard/channel-breakdown`/`GET /api/waste/summary`의 가맹점 `store_id` 강제(`order-permissions.test.js`), 동시 환불 요청 중 하나만 성공하고 나머지는 409(`refund-concurrency.test.js`, `claimRefundAmount` 조건부 UPDATE), 폴링·웹훅이 공유하는 판매 반영 로직 — 메뉴 자동 등록/레시피 미등록/재고 음수 감지/취소 재반영 방지(`sales-ingest.test.js`, `salesIngest.js`), 자동 동기화 시간창 계산과 `stores.sync_locked_at` 락 선점/해제(`sync-window.test.js`, `channels/toss.js` + `syncLock.js`의 순수 함수는 `server/src/syncWindow.js`), KST 기준 일별 집계 경계(`kst-bucketing.test.js`, `dbTime.js`의 `kstDayRange`/`dbStartOfKstToday`와 `/analytics` 방언별 일별 버킷), 자격증명 암호화·복호화 왕복과 평문/암호문 혼재 판별(`crypto.test.js`, `crypto.js`의 `isEncrypted`), 마이그레이션 적용 순서와 `transaction: false`가 필요한 스키마 변경(`migrations.test.js`). `GET /api/orders/refund-reasons`의 역할 검사와 브랜드 격리, `DELETE /api/orders/:id`의 역할 검사도 `order-permissions.test.js`에 있다.
  - **커버하지 않는 범위**: 리스크 감지 크론(`server/src/routes/risks.js`의 `checkPaymentOverdue`/`checkLowStock`), 발주서 CRUD(생성·임시저장·수정) 라우트 대부분(상태전이·환불 동시성·권한 경계는 위 신규 파일들이 커버), 클라이언트(`client/`)는 CI에서 빌드만 확인하고 별도 테스트는 없음.
  - **재료/가맹점 삭제는 소프트 삭제가 아니라, 참조 이력이 있으면 409로 거부하는 정책이다.** `DELETE /api/ingredients/:id`는 수불부/레시피/폐기 이력이 있으면, `DELETE /api/stores/:id`는 발주·매출·사용자 이력이 있으면 각각 409를 반환한다(`server/src/routes/api.js`). 가맹점은 삭제 대신 `is_open=false` 폐점 처리를 쓴다.
- **`initDb()` → 마이그레이션 전환이 미완료.** 베이스라인(`20260825000000_baseline.js`) 이후 스키마 변경만 마이그레이션으로 관리되고, 그 이전 레거시 스키마는 여전히 `initDb()`의 `createIfMissing`/`addColumnIfMissing` 반복 실행 방식에 남아 있다(`server/migrations/README.md`).
- **`stores.toss_api_key` deprecated 컬럼 잔존.** 위 4절 참고 — SQLite 테이블 재생성 위험 때문에 의도적으로 남겨둔 상태.
- **인덱스**: `20260825010000_add_hot_path_indexes.js`로 실제 쿼리 기준 9개를 추가했다(brand_id 기준 조회, FK 컬럼, `stock_ledger`/`waste_logs`). 각 인덱스의 근거 쿼리가 그 파일 주석에 있다. 새 조회를 추가할 때는 인덱스가 실제로 타는지 `EXPLAIN QUERY PLAN`으로 확인할 것.
- **토스 자격증명 암호화는 선택적이다.** `CREDENTIALS_KEY` 환경변수를 설정하면 `stores.toss_client_secret`, `stores.webhook_secret`, `store_integrations.credentials`(JSON 안의 `client_secret`)가 AES-256-GCM으로 암호화되어 저장된다(`server/src/crypto.js`). 미설정 시에는 여전히 평문으로 저장/조회된다 — DB 덤프가 유출되면 그대로 노출된다. **키를 분실하거나 교체하면 이미 암호화된 자격증명은 복구 불가능**하며(GCM 인증 태그 검증 실패로 명확히 에러를 던짐), `webhook_secret`이 포함되므로 해당 가맹점 웹훅 서명 검증이 전부 실패해 매출 유입이 끊긴다. 서버 기동마다 `server/src/credentialsBackfill.js`가 자기 치유 백필을 돌려, 키가 있는데 아직 평문인 자격증명을 자동으로 암호화한다 — "키 없이 먼저 배포 → 나중에 키 추가" 순서에서도 마이그레이션(`20260825020000_encrypt_store_credentials.js`, 한 번 적용되면 다시 안 돎)과 달리 매번 실행되어 이 경우를 놓치지 않는다.
- **로그인 잠금과 rate limit이 프로세스 메모리 기반**이라, 인스턴스를 여러 개 띄우면 인스턴스마다 따로 센다. 크론(`setInterval`)도 인스턴스마다 중복 실행된다. 스케일 아웃 전에 공유 스토어(Redis 등)와 크론 분리가 필요하다.
- **sqlite가 boolean 컬럼을 `1`/`0`으로 돌려준다.** 서버가 응답을 정규화하지 않으므로(운영 Postgres는 실제 `true`/`false`를 내려준다), 클라이언트가 `=== true` 대신 진리값(truthy/falsy) 판정으로 이 차이를 흡수하고 있다 — 근본 해결은 서버 응답 정규화지만 이번 범위에서는 하지 않았다.
- **목록 API(`GET /api/orders`, `/waste`, `/notices`, `/risks`)는 정식 페이지네이션(offset/cursor/총건수) 없이 `limit` 쿼리에 하드 상한 2000만 걸려 있다.** 데이터가 2000건을 넘는 가맹점/브랜드는 오래된 항목이 조용히 안 보인다 — 커서 기반 페이지네이션은 API 계약이 바뀌어 클라이언트 전면 수정으로 번지므로 의도적으로 미뤘다.
- 그 외 스키마 확장성 관점의 알려진 문제들(`stores` 테이블이 여러 성격의 컬럼을 떠안고 있는 점, `brand_id` 정합성이 DB 제약이 아닌 애플리케이션 코드에만 의존하는 점 등)은 `server/docs/db-schema-review.md`에 우선순위와 함께 정리되어 있다.
- 스테이징 검증은 무료 티어 VM의 Postgres에 IAP 터널로만 접속하는 구성으로 했다(5432 비공개).
