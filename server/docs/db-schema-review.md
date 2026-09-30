# DB 스키마 검토 — 확장성 관점

대상: [server/src/db/schema.js](../src/db/schema.js) (SQLite 로컬 / Postgres 프로덕션, knex 사용)
검토 기준: **나중에 기능을 추가할 때 최대한 안 꼬이는 구조인가** — 배민/쿠팡이츠/요기요 매출 연동을 잘못된 방향(불필요한 채널별 API 키·테이블)으로 설계했다가 되돌린 경험([channel 필드로 정리한 커밋](../src/channels/toss.js) 참고)에서 나온 문제의식으로 전체 스키마를 다시 봤다.

## 요약

가장 큰 리스크는 개별 컬럼이 아니라 **마이그레이션 방식 자체**다 — 버전 관리되는 마이그레이션 파일이 없고, 서버가 뜰 때마다 `initDb()`가 "컬럼 있으면 패스, 없으면 추가"를 반복 실행한다. 이 방식 위에서 8년 넘게(비유적으로) 기능이 쌓이면 `stores`, `orders` 같은 핵심 테이블이 계속 옆으로만 넓어지고, 한번 추가한 컬럼은 사실상 영원히 못 지운다. 실제로 `stores`에 `baemin_store_id` 등 3개 컬럼을 잘못 추가했다가 되돌린 일도 이 패턴의 축소판이다.

아래는 심각도 순으로 정리한 문제점과, 각각에 대한 개선안이다.

---

## 1. (구조적) 마이그레이션이 버전 관리되지 않음 — 가장 큰 리스크

**문제**
- `createIfMissing` / `addColumnIfMissing`이 매 서버 기동마다 스키마 전체를 다시 훑는다. 마이그레이션 파일도, 실행 이력 테이블도 없다 — "이 컬럼이 언제 왜 추가됐는지"는 git blame으로만 알 수 있고, 실행 시점에 어떤 마이그레이션까지 적용됐는지 DB 자체에는 기록이 없다.
- `addColumnIfMissing`은 항상 nullable 아니면 `defaultTo()`로만 컬럼을 추가할 수 있다 — 나중에 "이 컬럼은 사실 NOT NULL이어야 했다"는 걸 알아도 되돌릴 방법(백필 후 제약 추가)이 코드 패턴에 없다.
- **컬럼을 지우는 헬퍼가 아예 없다.** 그래서 `stores.toss_api_key`처럼 `// deprecated` 주석만 붙은 채 영구히 남는다. 잘못 추가했다가 되돌린 `baemin_store_id`/`coupangeats_store_id`/`yogiyo_store_id`도 로컬 DB엔 여전히 orphan 컬럼으로 남아있다 (스키마 코드에서는 제거했지만 이미 생성된 컬럼 자체를 지우는 로직은 없음).
- 여러 인스턴스가 동시에 뜨는 배포 환경(Render 재배포 등)에서 `hasColumn` 체크와 `ALTER TABLE`이 레이스 컨디션을 일으킬 수 있음 (지금 규모에선 확률 낮지만, 인스턴스 수가 늘면 문제가 됨).

**개선안**
- knex의 정식 `migrations` 디렉토리(`knex migrate:make`)로 전환. 최소한 "실행된 마이그레이션 이름"을 기록하는 테이블 하나(`knex_migrations`는 knex가 자동 생성)만 있어도 이력 추적이 된다.
- 전환이 부담되면, 지금 방식을 유지하되 **컬럼/테이블 제거용 헬퍼**(`dropColumnIfExists` 등)를 추가하고, "N개월 이상 안 쓰는 컬럼은 실제로 지운다"는 규칙을 정해서 `// deprecated`가 무한히 쌓이지 않게 한다.

---

## 2. `stores` 테이블이 "만능 서랍"이 되고 있음

**문제**
`stores`에는 서로 다른 성격의 데이터가 전부 컬럼으로 얹혀 있다:

| 성격 | 컬럼 |
|---|---|
| 매장 신원/연락처 | `name`, `owner_name`, `phone`, `address`, `business_number`, `open_date`, `franchise_type` |
| 운영 설정 | `order_deadline`, `delivery_days`, `is_open`, `assigned_user_id` |
| 토스페이먼츠(결제) 자격증명 | `toss_client_id`, `toss_client_secret`, `toss_api_key`(deprecated) |
| 토스플레이스(매출 동기화) 연동 | `toss_store_id`, `last_synced_at`, `webhook_secret` |

이번에 배민/쿠팡이츠/요기요를 (잘못) 추가할 때도 본능적으로 이 테이블에 컬럼 3개를 더 얹었다 — 패턴이 그렇게 유도한다. 이 구조에서 "새로운 외부 연동을 추가한다"는 매번 `stores`에 컬럼을 추가하는 일이 되고, 매장 하나가 같은 연동을 여러 개 가지는 경우(예: 매장이 토스플레이스 가맹점 ID를 두 개 쓰는 특수 케이스)는 아예 표현할 수 없다.

**개선안**
`stores`는 신원/운영 정보만 남기고, 외부 연동은 별도 테이블로 분리:

```
store_integrations
  id, store_id (FK), provider ('TOSS_PLACE' | 'TOSS_PAYMENTS' | ...),
  external_id, credentials(json/text), last_synced_at, created_at
  unique(store_id, provider)
```

이렇게 하면 새 연동 추가 = 새 row 추가(같은 provider 값으로), 스키마 변경이 필요 없다. `toss_client_id/secret`, `toss_store_id`, `last_synced_at`도 이 테이블로 옮기면 `stores`가 다시 얇아진다. (지금 당장 마이그레이션할 필요는 없지만, **다음 연동을 추가하기 전에** 이 리팩터를 먼저 하는 걸 권장 — 안 그러면 이번과 같은 실수가 반복된다.)

---

## 3. `toss_` 접두사가 서로 다른 3가지 개념을 가리킴

**문제** — 실제로 개발 중 혼란의 원인이 된 부분이다.

| 접두사가 붙은 값 | 실제로 가리키는 것 |
|---|---|
| `toss_client_id` / `toss_client_secret` / `toss_api_key` (stores) | **토스페이먼츠** — 발주 대금 결제 |
| `toss_store_id` / `TOSS_PLACE_ACCESS_KEY` / `TOSS_PLACE_SECRET_KEY` | **토스플레이스** — POS 매출 조회 |
| `orders.toss_order_id`, `sales_items.toss_order_id`/`toss_menu_id`, `menus.toss_menu_id` | 지금은 토스플레이스뿐 아니라 배민/쿠팡이츠/요기요 주문까지 담는 **범용 주문/메뉴 식별자** (channel 컬럼으로 구분) — 그런데 컬럼명은 여전히 `toss_`로 시작 |
| `purchase_orders.toss_order_code` / `toss_payment_key` | 또 다른 **토스페이먼츠** 결제 필드 |

서로 다른 3개의 토스 제품(결제/POS/범용 식별자)이 같은 접두사를 쓰고 있어서, 다음에 새 기능을 추가하는 사람이 `toss_`로 시작하는 아무 필드나 보고 "이건 토스플레이스 전용이구나"라고 잘못 추론하기 쉽다. 실제로 `orders.toss_order_id`가 이미 다채널을 담는 범용 컬럼이 됐다는 걸 확인하는 데 시간이 걸렸다.

**개선안**
- `orders.toss_order_id` → 의미상 `external_order_id`가 더 정확 (리네이밍은 참조하는 곳이 많아 비용이 크니, 최소한 스키마 주석에 "이제 범용 식별자"라고 명시하는 것부터).
- 신규 필드를 추가할 땐 `toss_` 대신 제품명을 명확히: `toss_place_*` (POS/매출) vs `toss_payments_*` (결제) 로 구분해서 같은 실수가 재발하지 않게 한다.

**Phase 1 적용 규칙**
기존 컬럼명은 유지한다. 앞으로 새 연동 필드를 추가할 때는 `toss_` 대신 `toss_place_*` (POS/매출) 또는 `toss_payments_*` (결제)로 제품을 명확히 구분한다.

---

## 4. FK가 걸려야 할 곳에 안 걸린 컬럼 2개

**문제**
- `alert_log.ingredient_id` — 다른 모든 `ingredient_id` 컬럼은 `.references('ingredients.id')`가 있는데 이것만 순수 정수 컬럼이다.
- `risk_alerts.acknowledged_by` — `users.id`를 가리키는 값인데( [routes/risks.js:57](../src/routes/risks.js#L57) 에서 `req.user.id`를 넣음) FK 참조가 없다.

이런 컬럼은 지금 당장은 앱 코드가 알아서 잘 채우고 있어서 문제가 안 보이지만, 나중에 "해당 재료/유저가 삭제됐을 때 이 로그는 어떻게 되나"를 결정할 때(CASCADE? SET NULL?) 스키마만 봐서는 답이 없고, 조인 기반 리포트 기능을 추가할 때 이 두 컬럼만 다르게 처리해야 하는 걸 매번 재발견하게 된다.

**개선안** — `.references(...).onDelete('SET NULL')`을 붙인다 (다른 `created_by`/`acknowledged_by` 류와 동일한 패턴으로 통일).

---

## 5. 핫 패스에 인덱스가 하나도 없음

**문제**
스키마 전체에 `t.index(...)` 호출이 **한 번도 없다.** unique 제약이 걸린 컬럼(예: `orders.toss_order_id`)만 부수적으로 인덱스가 생길 뿐, 대시보드/분석 라우트들이 상시로 필터링하는 조합에는 인덱스가 없다:

- `orders`: `store_id` + `processed_at` 범위 (대시보드, 정산, 채널별 매출 전부 이 패턴)
- `sales_items`: `store_id` + `sold_at` 범위 (Analytics, StoreRankings)
- `purchase_orders`: `store_id` + `status`
- `risk_alerts`: `brand_id` + `status`

로컬 SQLite/데이터 적은 지금은 안 느껴지지만, 이건 "지금 추가된 기능이 느려지는" 문제가 아니라 **앞으로 추가될 모든 리포트/대시보드 기능이 처음부터 풀스캔 위에서 만들어지는** 문제라서 확장성 관점에서 꼭 짚어야 한다. Render Postgres로 실데이터가 쌓이기 시작하면 눈에 띄게 느려질 조합들이다.

**개선안** — 위 4개 조합에 복합 인덱스 추가. knex에서는 테이블 생성 블록에 `t.index(['store_id', 'processed_at'])` 한 줄이면 된다.

---

## 6. JSON 텍스트 컬럼 두 종류가 다른 이유로 위험함

**문제**
- `order_templates.items` — `{product_id, product_name, unit, unit_price, quantity}[]`를 JSON 문자열로 통째로 저장한다 ([routes/orderTemplates.js](../src/routes/orderTemplates.js)). 반면 실제 발주서의 품목은 `purchase_order_items`라는 정식 테이블이다 — **같은 개념("품목 리스트")이 두 가지 다른 방식으로 모델링**되어 있다. 상품이 이름/가격이 바뀌어도 템플릿의 JSON 스냅샷은 안 바뀌므로, "발주 시점엔 최신 상품 정보로 보여줘야 하는" 템플릿의 성격과 맞지 않게 조용히 낡은 값을 계속 보여줄 수 있다. FK가 없어서 상품이 삭제(`is_active=false`)돼도 템플릿엔 여전히 표시되는데, 이게 의도인지 버그인지 스키마만 봐서는 알 수 없다.
- `orders.raw_payload` — 이건 반대로 **의도된 원본 보관용**이라 문제는 없지만, 여기서 뽑아낸 금액 필드들(`list_price`, `discount_amount`, `total_amount`, `cash_amount`, `card_amount`, `other_amount`)이 토스플레이스 결제 구조(현금/카드/기타 3분류)에 딱 맞춰 굳어 있다. 배달앱 결제처럼 이 3분류에 안 맞는 채널이 늘어나면(이미 `channel` 컬럼으로 배민 주문도 같은 orders 테이블에 들어오는데, 배달앱 결제는 대부분 현금도 카드도 아닌 "기타"로만 뭉뚱그려 잡힐 것) 채널별 결제수단 분석 같은 기능을 못 만든다.

**개선안**
- `order_templates.items`를 `order_template_items` 정식 테이블로 정규화 (product_id FK 포함) — `purchase_order_items`와 동일한 패턴으로 통일. 최소한 "이건 스냅샷이 아니라 최신값을 다시 조회해서 보여준다"는 걸 라우트 주석에 명시.
- `cash_amount`/`card_amount`/`other_amount`는 토스플레이스 전용 분해로 이름을 명확히 하거나(`toss_cash_amount` 등), 채널별로 무의미해지는 걸 감안해 향후엔 `payment_method` 자유 텍스트 + `amount` 조합의 별도 결제 상세 테이블로 확장할 여지를 열어둔다.

---

## 7. 상태값(enum)이 전부 자유 문자열 + 주석으로만 정의됨

**문제**
`purchase_orders.status`, `payments.status`, `risk_alerts.type`/`severity`/`status`, `stock_ledger.type` 전부 `t.string()`이고, 허용값은 컬럼 옆 한 줄 주석이 유일한 "스펙"이다. DB 레벨 제약(CHECK)도 없고, 코드 전체에 공유되는 상수 모듈도 없어서(각 라우트 파일에 문자열 리터럴로 흩어져 있음) 오타(`'CANCELLED'` vs `'CANCELED'`)가 나도 아무도 막아주지 않는다.

**개선안**
- `server/src/constants.js` 하나 만들어서 `ORDER_STATUSES`, `RISK_TYPES`, `RISK_SEVERITIES` 등을 배열/객체로 export하고, 라우트에서 문자열 리터럴 대신 이 상수를 참조하도록 점진적으로 옮긴다. (SQLite/Postgres CHECK 제약까지는 지금 구조상 과할 수 있어 우선순위는 낮음 — 앱 레벨 상수 통일이 비용 대비 효과가 큼.)

---

## 8. 브랜드 격리(`brand_id`)가 애플리케이션 코드에만 의존함

**문제**
대부분의 테이블이 `store_id`와 `brand_id`를 **둘 다** 들고 있다(조인 없이 브랜드 단위 집계를 빠르게 하기 위한 의도적 비정규화로 보임). 그런데 `orders.brand_id`가 실제로 `orders.store_id → stores.brand_id`와 일치하는지 강제하는 DB 제약이 없다 — 전적으로 매 INSERT마다 애플리케이션 코드가 올바른 `brand_id`를 같이 넣어주는 것에 의존한다. 지금까지는 다 그렇게 하고 있지만(코드 확인함), 새 기능을 추가하는 사람이 이 규칙을 모르고 `store_id`만 넣고 `brand_id`를 빠뜨리면 그 데이터는 브랜드별 필터링에서 조용히 누락되거나(다른 브랜드로) 잘못 집계된다.

**개선안** — 즉시 고칠 문제는 아니고, **문서화**가 우선이다. 이 문서 자체가 그 역할을 하지만, 추가로 각 라우트의 insert 헬퍼를 만들 때 `store_id`로부터 `brand_id`를 자동으로 채우는 공용 함수(`insertForStore(table, storeId, data)` 같은)를 두면 사람이 실수로 빠뜨릴 여지가 줄어든다.

**Phase 1/2A 적용** — `server/src/dbHelpers.js`에 `insertForStore(knex, table, storeId, data)` 헬퍼를 추가했다. 처음엔 웹훅의 주문/판매 insert에 적용했으나, 그 두 곳은 `onConflict().merge()`/`.ignore()` 체이닝을 쓰는데 `insertForStore`가 내부에서 `await`하는 `async` 함수라 반환값이 체이닝 불가능한 `Promise`라는 걸 놓쳐 실제 웹훅 주문 처리가 항상 실패하는 회귀가 생겼다 — 독립 검토 중 발견해 되돌렸다. 현재 `insertForStore`는 어디서도 호출되지 않는 상태이고, 체이닝이 없는 단순 insert 지점부터 다시 적용을 검토해야 한다.

---

## 9. 보존 정책이 스키마가 아니라 크론 코드에 숨어 있음

**문제**
[server/src/index.js](../src/index.js)의 일일 정리 작업이 `RESOLVED`/`DISMISSED` 상태의 `risk_alerts`를 180일 후, `order_history`를 365일 후 하드 삭제한다. 이 규칙은 스키마 어디에도 드러나지 않고 크론 잡 코드 안에만 있다 — 나중에 "지난 2년치 리스크 알림 통계를 보여주는" 기능을 추가하려는 사람은 왜 오래된 데이터가 없는지 한참 찾아야 한다.

**개선안** — 최소한 이 문서나 테이블 옆 주석에 "이 테이블은 N일 후 하드 삭제됨"을 명시. 이번 작업에서 `schema.js`의 `risk_alerts`/`order_history` 테이블 옆에 실제 보존기간과 `runDataCleanup` 위치를 주석으로 추가했다. 장기 통계가 필요해지면 삭제 대신 월별 집계 테이블로 롤업하는 방식으로 바꾸는 걸 고려.

---

## 우선순위 제안

지금 당장 다 고칠 필요는 없고, **다음에 뭔가를 추가하기 직전에** 아래 순서로 처리하는 걸 권장:

1. **(연동 기능을 또 추가하기 전에)** `store_integrations` 테이블 분리 — 이번과 같은 실수 재발 방지, 지금 이걸 안 하면 다음 채널 연동 때 또 `stores`에 컬럼을 얹게 됨
2. **(Postgres 실트래픽 전에)** 4개 핫 패스 인덱스 추가 — 코드 변경 없이 스키마만 추가하면 됨, 리스크 없음
3. **(여유 있을 때)** `order_templates.items` JSON → 정식 테이블 정규화, FK 2개 보강
4. **(장기)** 마이그레이션을 버전 관리 파일로 전환

---

## 검토 방법

이 문서는 [schema.js](../src/db/schema.js) 전체를 읽고, 각 테이블을 참조하는 라우트 코드([routes/*.js](../src/routes/))에서 실제 사용 패턴을 확인해 작성했다. 인덱스 부재, FK 누락 두 항목은 `grep -n "t.index\|acknowledged_by\|alert_log"`로 실제 코드에서 재확인했다.
