'use strict';

// POS 주문 1건을 우리 DB(orders/sales_items/ingredients/stock_ledger/risk_alerts)에 반영하는 로직의
// 단일 진실. 예전엔 이 로직이 웹훅 핸들러(routes/webhook.js) 안에만 있었고, 폴링(channels/toss.js의
// syncStoreSales)은 orders/sales_items만 채우고 재고 차감은 전혀 하지 않았다 — 그래서 웹훅이 등록 안
// 된 가맹점은 매출은 쌓이는데 재고가 영원히 안 줄어드는 문제가 있었다. 웹훅을 걷어내고 폴링 하나로
// 합치기로 하면서, "주문 하나를 반영/취소하는" 이 부분을 공용 모듈로 뽑아 웹훅과 폴링이 똑같은 코드를
// 타게 한다(동작이 두 군데서 갈라지면 그 어긋남이 재고 오차로 조용히 쌓인다 — menuResolver.js를
// 하나로 통일한 것과 같은 이유).
//
// 트랜잭션은 이 모듈이 스스로 열지 않는다 — 호출부(웹훅 라우트, 폴링의 주문 루프)가 이미 연 trx를
// 그대로 받는다. 그래야 "주문 행은 저장됐는데 재고는 안 깎임" 같은 어긋난 상태가 안 생긴다.
// createRisk는 내부에서 knex(트랜잭션이 아닌 커넥션)를 직접 쓰므로, 이미 열린 트랜잭션 안에서 부르면
// SQLite 단일 커넥션 풀에서 서로 커넥션을 기다리며 교착 상태에 빠진다(CLAUDE.md 4절). 그래서 이
// 파일의 함수들은 트랜잭션 안에서는 "무엇을 알려야 하는지"(issues)만 모아 반환하고, 실제 createRisk
// 호출(emitRiskNotifications)은 호출부가 트랜잭션 커밋 후에 실행해야 한다.

const { isProduction } = require('./db/schema');
const { dbTimeAgo } = require('./dbTime');
const { extractOrderFinance } = require('./orderFinance');
const { logStockMovement } = require('./stockLedger');
const { STOCK_LEDGER_TYPES, RISK_TYPES, RISK_SEVERITIES } = require('./constants');
const { linkMenuToTossId } = require('./menuLinking');
// "메뉴 하나가 재료를 얼마나 먹는지" 계산은 이 파일에서 직접 하지 않는다 — 사입 계산(api.js)과
// 같은 로직을 써야 표준메뉴/세트 계산이 두 군데서 어긋나지 않는다(menuResolver.js 상단 주석 참고).
const { resolveConsumption } = require('./menuResolver');
// createRisk는 내부에서 knex(트랜잭션이 아닌 커넥션)를 직접 쓴다 — 위 설명 참고.
const { createRisk } = require('./routes/risks');

// store: { id, brand_id }. orderId는 수불부에 어떤 판매 건이 이 변동을 일으켰는지 남기기 위함
//
// 재고 차감/복구 + 수불부 기록은 호출부가 이미 열어둔 trx 전체(orders insert/update, sales_items
// 까지)와 하나의 트랜잭션으로 묶여야 한다 — 그렇지 않으면 "주문은 저장됐는데 재고는 안 깎임",
// "재고는 복구됐는데 주문은 여전히 매출로 잡힘" 같은 어긋난 상태가 남는다. 호출부가 두 곳(웹훅
// 어댑터, 폴링)뿐이라 fallback 없이 trx를 필수 인자로 둔다 — 실수로 knex(...)를 쓰면(SQLite는
// 커넥션 풀이 1개뿐이라) 이미 열린 트랜잭션과 서로 커넥션을 기다리며 교착 상태에 빠지므로,
// 애초에 선택지를 없애는 편이 안전하다.
// issues: 선택 인자. 넘기면 "메뉴 자동 발견/레시피 미등록/재고 음수"를 그 안에 쌓아둔다(mutate).
// 반환값(lowStockIngredients)의 의미/형태는 그대로 유지하고, 리스크 알림에 필요한 정보는 별도
// out-parameter로 빼낸 이유: 호출부(취소/생성 두 곳) 모두 이미 lowStockIngredients의 반환 타입에
// 의존하고 있어(길이 체크, map 등) 반환값 자체를 바꾸면 기존 동작이 깨진다.
async function adjustStock(trx, lineItems, multiplier, store, orderId, issues) {
  const lowStockIngredients = [];
  for (const item of lineItems) {
    const menuName = (item.item && item.item.title) || item.name || item.menuName;
    // sales_items에 적립할 때(ingestCompletedOrder)와 같은 규칙으로 ID를 뽑아야 한다 — 여기서만
    // 다른 필드(item.menuId만)를 보면 sales_items.toss_menu_id와 실제 매칭에 쓰는 값이 어긋나
    // 아래 ID 우선 매칭이 사실상 항상 빗나가게 된다.
    const menuId = (item.item && item.item.id) || item.menuId || null;
    const quantity = item.quantity || 1;

    // ID 우선 매칭 — 메뉴 이름은 가맹점이 POS에서 얼마든지 바꿀 수 있지만(사입 감시를 피하려고
    // 실제로 쓰는 수법이다), 토스가 매 주문마다 같이 보내주는 메뉴 고유 ID는 이름이 바뀌어도 그대로다.
    // ID가 있으면 그걸로 먼저 찾고, ID가 없거나(아직 우리 menus에 연결이 안 됨) 그 ID로 못 찾았을
    // 때만 이름으로 찾는다. 예전 코드는 `.orWhere({ toss_menu_id: item.menuId || '' })` 형태라
    // menuId가 없는 라인아이템마다 빈 문자열로 조회했는데, menus.toss_menu_id가 빈 문자열(값이 없어
    // '' 그대로 남은 행)인 메뉴가 있으면 이름이 전혀 다른데도 거기로 잘못 매칭될 수 있었다.
    let menu = null;
    if (menuId) {
      menu = await trx('menus').where({ store_id: store.id, toss_menu_id: menuId }).first();
    }
    if (!menu && menuName) {
      menu = await trx('menus').where({ store_id: store.id, name: menuName }).first();
      // 이름으로는 찾았는데 그 메뉴에 아직 ID가 없고 이번 주문에 ID가 들어왔다면 지금 연결해둔다.
      // 그러면 다음부터는(이름이 바뀌어도) 위 ID 매칭에서 계속 같은 메뉴로 잡혀 회피가 막힌다.
      // linkMenuToTossId가 "이미 채워져 있으면 스킵/다른 메뉴에 이 ID가 이미 붙어있으면 스킵"까지
      // 처리하므로 여기서는 호출만 하면 된다. 이미 열린 트랜잭션(trx) 안이므로 knex(...)가 아니라
      // 반드시 trx를 그대로 넘긴다(CLAUDE.md 4절 — SQLite 단일 커넥션 교착 방지).
      if (menu) await linkMenuToTossId(trx, menu, menuId);
    }
    let justAutoCreated = false;
    if (!menu) {
      // 예전엔 여기서 그냥 넘어갔다(issues.unmatchedMenus만 쌓고 continue) — 그러면 그 메뉴가
      // 팔릴 때마다 재고가 전혀 안 깎이는데도 본사가 그 사실을 알려면 리스크 알림을 보고 손으로
      // 메뉴를 만드는 수밖에 없었다. 매장마다 파는 게 달라 본사가 미리 다 등록해둘 수 없으므로,
      // 대신 여기서 자동으로 menus에 만들어둔다. 레시피는 당연히 없으니 재고는 안 깎인다 —
      // 이게 올바른 동작이다(모르는 레시피를 추측해서 깎으면 더 위험한 사고가 된다). 본사는
      // auto_discovered=true 목록을 보고 표준 메뉴 연결/레시피 지정을 하면 된다.
      // 반드시 trx 안에서 생성한다 — knex(...)를 쓰면 SQLite 단일 커넥션에서 이미 열린 트랜잭션과
      // 교착 상태에 빠진다(CLAUDE.md 4절).
      const [inserted] = await trx('menus').insert({
        brand_id: store.brand_id, store_id: store.id,
        name: menuName || '(빈 메뉴명)', toss_menu_id: menuId || null,
        auto_discovered: true, is_active: true,
      }).returning('id');
      const newMenuId = inserted?.id ?? inserted;
      menu = await trx('menus').where({ id: newMenuId }).first();
      justAutoCreated = true;
      // 같은 주문 안에서 같은(아직 미등록이던) 메뉴가 여러 줄로 다시 나오거나, 다음 주문에서 같은
      // 이름/ID로 다시 팔리면 이 분기 위쪽의 ID/이름 매칭에서 방금 만든 행이 그대로 잡히므로
      // 중복 생성되지 않는다.
      if (issues) issues.autoDiscoveredMenus.push({ menuName: menu.name, menuId: menu.id, lineItem: truncateLineItem(item) });
    }

    // 표준메뉴 연결(recipe_source_menu_id)/세트 구성(menu_components)까지 포함해 이 메뉴가 실제로
    // 소모하는 재료를 계산한다. 이 계산은 사입 계산(api.js)과 반드시 같은 로직이어야 하므로
    // menuResolver.js 하나로 통일했다 — 두 군데 따로 만들면 언젠가 어긋나고, 그 어긋남이 사입
    // 회피 경로가 된다(menuResolver.js 상단 주석 참고).
    const consumption = await resolveConsumption(trx, menu, quantity);

    if (consumption.length === 0 && issues && !justAutoCreated) {
      // 메뉴는 찾았지만(또는 이미 자동등록되어 있지만) 레시피/표준메뉴연결/세트구성이 전부
      // 비어있는 경우 — 증상은 메뉴 매칭 실패와 똑같다(재고 무변동). 방금 이 판매에서 막 자동
      // 생성한 메뉴는 위에서 이미 autoDiscoveredMenus로 알렸으므로 여기서 또 중복으로 알리지
      // 않는다 — 하지만 다음 판매(같은 메뉴가 여전히 레시피 미지정 상태)부터는 이 분기로 계속
      // 알림이 간다.
      issues.noRecipeMenus.push({ menuName: menu.name, menuId: menu.id });
    }

    // pg에서 .forUpdate()로 재료 행을 잠그는데, 레시피에 정의된 순서대로 잠그면 두 주문이 같은 재료
    // 두 개를 서로 반대 순서로 잡아 교착에 빠질 수 있다. ingredient_id 오름차순으로 잠금 순서를 통일한다.
    const ordered = [...consumption].sort((a, b) => a.ingredient_id - b.ingredient_id);
    for (const c of ordered) {
      const delta = c.amount * multiplier;

      // 재료 행을 trx 안에서 다시 읽어 beforeStock을 구한다. PostgreSQL은 .forUpdate()로 행을
      // 잠가야 동시 주문의 read-modify-write 경합(둘 다 같은 beforeStock을 읽어 하나의 변동이
      // 유실되는 것)을 막을 수 있다. SQLite는 애초에 쓰기 트랜잭션이 통째로 직렬화되므로 잠금이
      // 필요 없다 — knex의 sqlite3 컴파일러가 .forUpdate()를 조용히 빈 문자열로 무시해서 굳이
      // 분기하지 않아도 에러는 안 나지만(직접 확인함), 실제로 잠그지 않는다는 걸 명시적으로
      // 드러내기 위해 isProduction(pg)에서만 붙인다.
      let ingredientQuery = trx('ingredients').where({ id: c.ingredient_id });
      if (isProduction) ingredientQuery = ingredientQuery.forUpdate();
      const ingredient = await ingredientQuery.first();
      if (!ingredient) continue;

      const beforeStock = ingredient.stock || 0;
      const afterStock = delta > 0 ? beforeStock - delta : beforeStock + Math.abs(delta);
      await trx('ingredients').where({ id: c.ingredient_id }).update({ stock: afterStock });

      await logStockMovement(trx, {
        brand_id: store.brand_id, store_id: store.id, ingredient_id: c.ingredient_id,
        type: multiplier > 0 ? STOCK_LEDGER_TYPES.SALE : STOCK_LEDGER_TYPES.SALE_CANCEL, delta: -delta,
        before_stock: beforeStock, after_stock: afterStock,
        ref_type: 'order', ref_id: null, memo: orderId ? `주문 ${orderId}` : null,
      });

      // 하한을 두지 않고 음수를 그대로 허용한다 — 여기서 0으로 막아버리면 "레시피 수량이 잘못됐다"는
      // 신호 자체가 사라지고 stock_ledger의 before/after 연속성도 끊긴다. 대신 감지해서 알린다.
      if (issues && afterStock < 0) {
        issues.negativeStock.push({
          ingredient_id: c.ingredient_id, name: ingredient.name, unit: ingredient.unit,
          before_stock: beforeStock, after_stock: afterStock, menu_name: menu.name,
        });
      }

      if (multiplier > 0) {
        if (afterStock <= ingredient.threshold && !lowStockIngredients.find(x => x.id === ingredient.id)) {
          lowStockIngredients.push({ ...ingredient, stock: afterStock });
        }
      }
    }
  }
  return lowStockIngredients;
}

// datetime 컬럼 값을 방언 무관하게 비교하기 위한 정규화. pg는 timestamptz를 JS Date로,
// sqlite는 문자열로 돌려주므로 `===` 비교는 pg에서 절대 참이 안 된다 — 둘 다 밀리초로 바꿔 비교한다.
function toMs(v) {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}
function sameSoldAt(a, b) {
  const ma = toMs(a);
  const mb = toMs(b);
  return Number.isFinite(ma) && Number.isFinite(mb) && ma === mb;
}

function newIssues() {
  return { autoDiscoveredMenus: [], noRecipeMenus: [], negativeStock: [], cancelledReingest: [] };
}

// 매칭 실패한 라인아이템의 원본을 risk_alerts.detail에 담기 위한 방어적 자르기. 세트메뉴/옵션이
// 중첩 객체로 올 수도 있어 크기를 예측하기 어렵고, 주문 한 건에 매칭 실패 항목이 여러 개면
// detail 전체가 계속 커진다 — TEXT 컬럼 하나에 다 들어가므로 항목당 상한을 둬서 다른 정보(메뉴명
// 요약 등)를 밀어내지 않게 한다. 2000자면 실제 라인아이템 구조를 파악하기엔 충분하고도 남는다.
const MAX_LINE_ITEM_LOG_CHARS = 2000;
function truncateLineItem(item) {
  try {
    const json = JSON.stringify(item);
    if (!json || json.length <= MAX_LINE_ITEM_LOG_CHARS) return item;
    return { _truncated: true, _original_length: json.length, preview: json.slice(0, MAX_LINE_ITEM_LOG_CHARS) };
  } catch {
    return null; // 순환 참조 등으로 직렬화가 실패해도 알림 생성 자체는 막지 않는다
  }
}

// issues에 쌓인 내용을 risk_alerts용 알림 0~2건으로 변환한다. 트랜잭션 밖(커밋 후)에서만 호출할 것.
// 주문 한 건에 메뉴가 여러 개 안 맞을 수 있으므로, 메뉴별로 알림을 따로 만들지 않고 (브랜드,가맹점,타입)
// 당 1건으로 묶는다 — createRisk의 중복 방지가 애초에 이 단위(타입 기준)라 메뉴별로 나눠 만들어봤자
// 먼저 만들어진 1건만 남고 나머지는 그 설명을 덮어쓰기만 반복하게 된다. checkLowStock이 가맹점당
// 부족 재료를 한 알림에 모아 담는 것과 같은 방식.
function buildRiskNotifications(issues) {
  const notifications = [];

  if (issues.autoDiscoveredMenus.length > 0 || issues.noRecipeMenus.length > 0) {
    const parts = [];
    if (issues.autoDiscoveredMenus.length > 0) {
      const names = [...new Set(issues.autoDiscoveredMenus.map(m => m.menuName))];
      const shown = names.slice(0, 3).join(', ');
      const more = names.length > 3 ? ` 외 ${names.length - 3}종` : '';
      // 예전 문구("미등록 메뉴명 ... 메뉴 등록 필요")는 더 이상 맞지 않는다 — 이제는 메뉴 자체는
      // menus에 자동 등록되고(auto_discovered=true), 본사가 할 일은 "등록"이 아니라 "레시피
      // 지정(또는 이미 있는 표준 메뉴에 연결)"이다.
      parts.push(`신규 메뉴 자동 등록: ${shown}${more} — 판매 유입으로 메뉴가 자동 생성되었으나 레시피가 없어 재고가 차감되지 않습니다. 레시피 지정 또는 표준 메뉴 연결 필요`);
    }
    if (issues.noRecipeMenus.length > 0) {
      const names = [...new Set(issues.noRecipeMenus.map(m => m.menuName))];
      const shown = names.slice(0, 3).join(', ');
      const more = names.length > 3 ? ` 외 ${names.length - 3}종` : '';
      parts.push(`레시피 미등록 메뉴: ${shown}${more} — 메뉴는 있지만 레시피/표준메뉴연결/세트구성이 전부 없어 재고가 차감되지 않습니다`);
    }
    notifications.push({
      type: RISK_TYPES.MENU_UNMATCHED,
      // 시스템의 존재 이유(재고 자동 차감)가 조용히 무력화되는 상황이라 HIGH. 실사 전까지 아무도
      // 못 알아채고 그 사이 재고 데이터가 계속 틀어진다.
      severity: RISK_SEVERITIES.HIGH,
      description: parts.join(' / '),
      detail: { auto_discovered_menus: issues.autoDiscoveredMenus, no_recipe_menus: issues.noRecipeMenus },
    });
  }

  if (issues.negativeStock.length > 0) {
    // 같은 재료가 여러 메뉴/라인에서 반복 등장할 수 있으니 재료 기준으로 묶고, 최종(가장 나중) 상태만 남긴다.
    const byIngredient = new Map();
    for (const n of issues.negativeStock) byIngredient.set(n.ingredient_id, n);
    const items = [...byIngredient.values()];
    const shown = items.slice(0, 3).map(i => `${i.name} ${i.after_stock}${i.unit}`).join(', ');
    const more = items.length > 3 ? ` 외 ${items.length - 3}종` : '';
    notifications.push({
      type: RISK_TYPES.NEGATIVE_STOCK,
      // 매출 유실은 아니고(주문 자체는 정상 기록됨) 재료 재고 수치만 오염되는 것이라 MENU_UNMATCHED보다는
      // 낮게, 하지만 대시보드/발주추천/재고부족 알림에 그대로 반영되어 잘못된 발주로 이어질 수 있으니
      // LOW_STOCK(MEDIUM)과 같은 수준으로 잡는다.
      severity: RISK_SEVERITIES.MEDIUM,
      description: `재고 음수 발생: ${shown}${more} — 레시피 소모량 또는 실제 재고를 확인해주세요`,
      detail: { ingredients: items },
    });
  }

  if (issues.cancelledReingest.length > 0) {
    const ids = [...new Set(issues.cancelledReingest.map(r => r.orderId))];
    notifications.push({
      type: RISK_TYPES.SALES_REINGEST_BLOCKED,
      // 매출/재고가 즉시 틀어지지는 않지만(반영을 차단했으므로) POS 데이터가 취소↔완료로 흔들린다는
      // 뜻이라 원인 확인이 필요하다. MENU_UNMATCHED(HIGH)처럼 재고가 실제로 안 깎이는 상황은 아니라 MEDIUM.
      severity: RISK_SEVERITIES.MEDIUM,
      description: `취소된 주문이 완료로 재유입되어 반영을 차단했습니다: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` 외 ${ids.length - 3}건` : ''} — POS 취소/완료 상태를 확인해주세요`,
      detail: { orders: issues.cancelledReingest },
    });
    // 예전엔 `console.warn`만 남겨 아무도 안 봤다 — CLAUDE.md가 경고하는 바로 그 패턴이다.
  }

  return notifications;
}

// 트랜잭션 커밋 후에만 호출. 리스크 생성 실패로 판매 반영(주문/재고 반영) 자체가 실패하면 안 되므로
// 여기서 던지는 예외는 호출부에서 잡아 로그만 남기고 삼킨다.
async function emitRiskNotifications(store, issues) {
  const notifications = buildRiskNotifications(issues);
  for (const n of notifications) {
    try {
      await createRisk(store.brand_id, store.id, n.type, n.severity, n.description, n.detail);
    } catch (e) {
      console.error('[판매반영] 리스크 알림 생성 실패:', n.type, e);
    }
  }
}

// raw_payload(JSON 문자열)에서 라인아이템을 뽑아낸다. 저장 형태가 두 갈래로 존재한다:
//   - 웹훅이 저장한 것(예전 webhook.js): { data: { order: { lineItems } } } 통짜 envelope,
//     드물게 { data: { lineItems } } 형태도 있었다(레거시).
//   - 폴링(channels/toss.js)이 저장한 것: order 노드 자체가 최상위 — lineItems/orderItems/items.
// reverseCancelledOrder가 취소 이벤트에 라인아이템이 같이 오지 않을 때(webhook.js의 취소 페이로드가
// orderId만 준다) 원래 주문 행의 raw_payload를 다시 파싱해 재료 소모량을 계산하기 위해 필요하다.
function extractLineItemsFromRawPayload(rawPayloadJson) {
  let parsed;
  try {
    parsed = JSON.parse(rawPayloadJson);
  } catch {
    return [];
  }
  return (parsed.data && parsed.data.order && parsed.data.order.lineItems)
    || (parsed.data && parsed.data.lineItems)
    || parsed.lineItems || parsed.orderItems || parsed.items
    || [];
}

// COMPLETED 주문 1건을 반영한다. 트랜잭션은 호출부가 연다.
// order: 정규화된 토스 주문 객체(id, createdAt, lineItems, chargePrice, payments 등이 최상위에
//   있는 형태) — 웹훅은 { data: { order: {...} } }로 감싸져 오므로 어댑터(routes/webhook.js)가
//   getOrderNode 등으로 풀어서 넘겨야 한다. 폴링(channels/toss.js)은 API 응답의 order가 원래
//   이 형태다(orderFinance.js 상단 주석 참고).
// channel: 'POS'/'BAEMIN' 등 주문 출처. 없으면 'POS'로 간주(과거 스키마 기본값과 동일).
// 반환: { applied, skipped, issues, lowStockAlert }
//   applied=false → 이미 이 주문 id로 반영된 행이 있어 재고/판매내역을 다시 만들지 않았다는 뜻
//   (주문 행 자체는 최신 정보로 갱신한다 — 결제수단/금액 정정 등은 반영할 가치가 있다).
//   skipped=true → 이미 CANCELLED로 되돌린 주문을 폴링이 COMPLETED로 다시 보는 경우. 주문 행조차
//   갱신하지 않고 완전히 건너뛴다(아래 본문 참고).
//   order_state는 이 함수가 호출됐다는 사실 자체를 신뢰해 항상 'COMPLETED'로 강제 저장한다 —
//   웹훅 페이로드에는 orderState 필드가 아예 없거나 정확하지 않을 수 있는데(예전 webhook.js는
//   payload의 orderState 유무와 무관하게 "생성" 이벤트를 곧바로 완료 판매로 취급해 재고를 깎았다),
//   저장된 order_state가 실제 처리 내용과 다르면 나중에 취소가 들어왔을 때 reverseCancelledOrder가
//   "이전 상태가 COMPLETED였는지"로 재고 복구 여부를 판단하지 못해(원래 값이 null이면 복구를
//   건너뛰어) 재고가 영원히 안 돌아오는 사고로 이어진다.
//
// 중복 방지는 "존재 확인 SELECT"가 아니라 "조건부 UPDATE의 영향 행 수"로 한다. 예전엔
// `existing = await trx('orders').where(...).first()`로 먼저 읽고 그 결과로 분기했는데,
// 웹훅과 폴링이 같은 주문을 동시에 처리하면(Postgres READ COMMITTED) 두 트랜잭션 모두
// existing=null을 읽어버려서 둘 다 최초 반영 경로를 타 재고가 이중으로 차감될 수 있었다.
// `orders.toss_order_id` UNIQUE는 insert 자체만 직렬화할 뿐, 이미 읽어버린 existing 값을
// 되돌려주지 않는다. 대신 "INGESTING이라는 임시 상태를 조건으로 건 UPDATE가 몇 행을
// 바꿨는지"로 소유권을 가린다 — UPDATE는 대상 행을 실제로 잠그므로, 동시에 같은 주문을 보는
// 두 트랜잭션 중 먼저 커밋하는 쪽만 1행을 얻는다.
async function ingestCompletedOrder(trx, store, order, channel) {
  const orderId = String(order.id);
  const soldAt = order.createdAt || new Date().toISOString();
  const ch = channel || 'POS';
  // extractOrderFinance가 돌려주는 order_state는 토스 페이로드 원본(orderState)이라 우리 내부
  // 상태 머신(INGESTING/COMPLETED/CANCELLED)과 다르다 — 아래에서 항상 명시적으로 덮어쓴다.
  const finance = extractOrderFinance(order);
  const rawPayloadJson = JSON.stringify(order);

  // 1) 이 주문 id로 행이 없으면 INGESTING(예약) 상태로 만든다. 이미 있으면(다른 트랜잭션이
  // 먼저 반영했거나 반영 중) 조용히 무시한다 — sqlite/pg 모두 정수 rowcount를 주므로 방언
  // 분기가 필요 없다.
  await trx('orders').insert({
    brand_id: store.brand_id, store_id: store.id,
    toss_order_id: orderId, raw_payload: rawPayloadJson,
    processed_at: soldAt, channel: ch,
    ...finance,
    order_state: 'INGESTING',
  }).onConflict('toss_order_id').ignore();

  // 2) 이 행이 아직 INGESTING이면(=내가 방금 만들었거나, 먼저 예약했던 트랜잭션이 커밋 전에
  // 죽어 사라진 뒤 내가 다시 만든 것) COMPLETED로 승격시킨다. 이 UPDATE가 행을 잠그므로, 같은
  // 주문을 동시에 보는 다른 트랜잭션의 같은 UPDATE는 내가 커밋할 때까지 대기하다가 재평가되면
  // order_state가 이미 COMPLETED로 바뀐 뒤라 조건에 안 맞아 0행을 얻는다(내가 중간에 죽어
  // 롤백되면 INGESTING 행 자체가 사라지므로, 그 트랜잭션의 1번 INSERT가 대신 새 예약 행을
  // 만들어 1행을 얻게 된다). 그래서 이 rowcount가 "내가 이 주문의 소유권을 얻었는가"의 유일한
  // 판정 기준이다.
  // `orders.toss_order_id`가 전역 UNIQUE인데 선점 UPDATE와 후속 조회에 store_id 조건이 없어,
  // 두 가맹점에 같은 주문 ID가 오면 B점 페이로드가 A점 주문 행을 덮어쓰고 B점 매출·재고는 무음으로
  // 유실됐다(reverseCancelledOrder에는 원래 이 조건이 있었다). DB 제약((store_id, toss_order_id)
  // 복합 UNIQUE)이 근본이지만 sqlite에서 UNIQUE 변경은 orders 테이블 재생성이라 별도 작업으로
  // 남긴다 — 그때까지는 이 조건과 아래 throw가 유일한 방어선이다.
  const won = await trx('orders')
    .where({ toss_order_id: orderId, store_id: store.id })
    .where('order_state', 'INGESTING')
    .update({
      raw_payload: rawPayloadJson, processed_at: soldAt, channel: ch,
      ...finance,
      order_state: 'COMPLETED',
    });

  if (won !== 1) {
    // 소유권을 못 얻었다 — 다른 트랜잭션이 이미 이 주문을 반영했거나 취소 처리했다는 뜻이니
    // 실제 상태를 다시 읽어 기존 규칙대로 분기한다.
    const existing = await trx('orders').where({ toss_order_id: orderId, store_id: store.id }).first();

    if (existing && existing.order_state === 'CANCELLED') {
      // 이미 취소 처리된 주문을 폴링/웹훅이 COMPLETED로 다시 보는 경우. 재반영(재고 재차감)은
      // 하지 않는다 — 폴링이 3분마다 같은 창을 다시 보므로 재반영 경로를 열면 취소↔완료가
      // 번갈아 보일 때마다 재고가 계속 흔들린다. 건너뛰고 리스크로 눈에 띄게 남긴다(예전엔
      // console.warn만 남겨 아무도 안 봤다 — CLAUDE.md가 경고하는 바로 그 패턴이다).
      const issues = newIssues();
      issues.cancelledReingest.push({ orderId, storeId: store.id });
      return { applied: false, skipped: true, issues, lowStockAlert: null };
    }

    if (existing && existing.order_state === 'COMPLETED') {
      // 폴링이 3분마다 같은 창을 다시 보므로, 이미 반영된 주문도 매번 전체 컬럼 UPDATE가 나갔다
      // (하루 300건 매장이면 한 달에 28만 행 버전). 실제로 달라진 게 없으면 건드리지 않는다.
      // processed_at은 pg에서 timestamptz 컬럼이라 knex pg가 이 값을 JS Date 객체로 돌려준다
      // (knexfile.js에 타입 파서 오버라이드가 없다) — soldAt(ISO 문자열)과 `===`로 비교하면
      // Date와 string은 절대 같을 수 없어 이 스킵 조건이 pg(운영)에서 한 번도 발동하지 않는다.
      // 방언 무관하게 밀리초 타임스탬프로 정규화해서 비교한다.
      if (existing.raw_payload === rawPayloadJson && existing.channel === ch && sameSoldAt(existing.processed_at, soldAt)) {
        return { applied: false, skipped: false, issues: newIssues(), lowStockAlert: null };
      }
      // 이미 반영된 주문 — 재고/판매내역은 다시 만들지 않되, 결제수단/금액 정정 등은 반영할
      // 가치가 있으므로 주문 행 자체는 최신 정보로 갱신한다.
      await trx('orders').where({ toss_order_id: orderId, store_id: store.id }).update({
        raw_payload: rawPayloadJson, processed_at: soldAt, channel: ch,
        ...finance, order_state: 'COMPLETED',
      });
      return { applied: false, skipped: false, issues: newIssues(), lowStockAlert: null };
    }

    if (existing && existing.order_state == null) {
      // order_state 컬럼이 생기기 전에 들어온 레거시 행. 재고를 깎은 기록이 확실하지 않으니 재차감은
      // 하지 않고, 주문 행만 최신 정보로 갱신하고 COMPLETED로 표시해 다음 폴링부터 정상 분기를 타게 한다.
      // (예전 onConflict.merge() 코드가 하던 치유를 명시적으로 되살린 것 — 이 분기가 없으면 레거시 행
      //  하나 때문에 매 폴링이 아래 throw로 실패해 last_synced_at이 재시도 창에 영구 고착된다.)
      await trx('orders').where({ toss_order_id: orderId, store_id: store.id }).update({
        raw_payload: rawPayloadJson, processed_at: soldAt, channel: ch, ...finance, order_state: 'COMPLETED',
      });
      return { applied: false, skipped: false, issues: newIssues(), lowStockAlert: null };
    }

    // 여기까지 왔다는 건 (1) 같은 toss_order_id를 다른 가맹점이 이미 갖고 있어 우리 insert가 무시되고
    // 우리 store_id로는 행이 안 보이거나 (2) 예상 밖 order_state라는 뜻이다. 예전엔 조용히 return해서
    // 그 가맹점의 매출·재고가 아무 흔적 없이 사라졌다. 던져서 processOneOrder가 failed로 집계하게 하면
    // last_synced_at이 밀리지 않고 SYNC_FAILED로 사람 눈에 띈다.
    // (pg는 onConflict().ignore()가 동시 미커밋 insert에서 블로킹되고 sqlite는 쓰기 트랜잭션이
    //  직렬화되므로, "정상적인 동시 처리" 상황에서는 existing이 반드시 채워진다 — 이 throw는
    //  진짜 이상 상황에서만 난다.)
    throw new Error(`[판매반영] 주문 소유권 판정 실패 — 같은 toss_order_id가 다른 가맹점에 이미 존재하거나 예상 밖 상태입니다 (orderId=${orderId}, store=${store.id}, state=${existing ? existing.order_state : '행 없음'})`);
  }

  // 여기부터는 이 트랜잭션이 이 주문의 소유권을 얻은 경우(최초 반영)뿐이다.
  const lineItems = order.lineItems || order.orderItems || order.items || [];

  // sales_items의 unique는 (toss_order_id, menu_name)이고 .ignore()라, 한 주문에 같은 메뉴가 두 줄로
  // 오면 두 번째 줄이 조용히 버려졌다. 재고는 adjustStock이 라인 두 개 모두 깎으므로, 판매집계와
  // 사입 감시만 실제보다 적게 잡히는 어긋남이 생긴다(사입 회피 경로가 된다).
  // insert 전에 메뉴명 기준으로 수량·금액을 합산한다. 재고 차감(adjustStock)은 원본 lineItems를
  // 그대로 받아야 하므로 손대지 않는다.
  const salesByMenu = new Map(); // menu_name -> { menu_name, toss_menu_id, quantity, amount, unit_price }
  for (const item of lineItems) {
    const menuName = (item.item && item.item.title) || item.name || item.menuName || '';
    const menuId = (item.item && item.item.id) || item.menuId || null;
    const qty = item.quantity || 1;
    const unitPrice = (item.itemPrice && item.itemPrice.priceValue) || (item.item && item.item.price) || item.unitPrice || item.price || 0;
    if (!menuName) continue;
    const amount = Math.round(unitPrice * qty);
    const existingRow = salesByMenu.get(menuName);
    if (existingRow) {
      existingRow.quantity += qty;
      existingRow.amount += amount;
    } else {
      salesByMenu.set(menuName, { menu_name: menuName, toss_menu_id: menuId, quantity: qty, unit_price: unitPrice, amount });
    }
  }
  if (salesByMenu.size > 0) {
    await trx('sales_items').insert([...salesByMenu.values()].map(row => ({
      brand_id: store.brand_id, store_id: store.id,
      toss_order_id: orderId, menu_name: row.menu_name, toss_menu_id: row.toss_menu_id,
      quantity: row.quantity, unit_price: row.unit_price, amount: row.amount,
      sold_at: soldAt, channel: ch,
    }))).onConflict(['toss_order_id', 'menu_name']).ignore();
  }

  const issues = newIssues();
  const lowStockIngredients = await adjustStock(trx, lineItems, 1, store, orderId, issues);

  let lowStockAlert = null;
  if (lowStockIngredients.length > 0) {
    // alert_log.sent_at은 knex.fn.now() 기본값이라 sqlite에서 'YYYY-MM-DD HH:MM:SS'인데 ISO
    // 문자열과 비교하면 공백 < 'T'라 항상 '최근 알림 없음'으로 판정돼 1시간 쿨다운이 통째로
    // 무력화됐다(주문 4건 → alert_log 4행). dbTime.js의 방언별 포매터로 맞춘다.
    const oneHourAgo = dbTimeAgo(3600000);
    const toAlert = [];
    for (const i of lowStockIngredients) {
      const recent = await trx('alert_log')
        .where({ ingredient_id: i.id, store_id: store.id })
        .where('sent_at', '>', oneHourAgo)
        .first();
      if (!recent) toAlert.push(i);
    }
    if (toAlert.length > 0) {
      await trx('alert_log').insert(toAlert.map(i => ({ ingredient_id: i.id, stock_at_alert: i.stock, store_id: store.id })));
      lowStockAlert = { type: 'LOW_STOCK', brandId: store.brand_id, storeId: store.id, storeName: store.name, ingredients: toAlert.map(i => ({ name: i.name, stock: i.stock, unit: i.unit, threshold: i.threshold })) };
    }
  }

  return { applied: true, skipped: false, issues, lowStockAlert };
}

// CANCELLED 주문 1건을 되돌린다. 트랜잭션은 호출부가 연다.
// order: 최소 { id }. 폴링은 취소된 주문도 API가 lineItems까지 그대로 내려주므로 order.lineItems가
//   있으면 그걸 우선 쓰고, 없으면(웹훅의 취소 페이로드는 orderId만 준다) 원래 주문 행의
//   raw_payload를 다시 파싱해서 얻는다.
// 반환: { reversed, issues }
//   reversed=false인 경우: (1) 원래 주문 행 자체가 없음(반영한 적이 없으니 되돌릴 것도 없음)
//   (2) 원래 상태가 COMPLETED가 아니었음(재고를 깎은 적이 없으므로 복구하면 오히려 재고가
//   늘어나버린다 — 처음부터 CANCELLED로 들어온 주문, 또는 이미 취소 처리된 주문을 다시 보는 경우).
//
// 판정은 "존재 확인 SELECT"가 아니라 "COMPLETED→CANCELLED 조건부 UPDATE의 영향 행 수"로 한다.
// 예전엔 먼저 SELECT로 original을 읽어 wasCompleted를 판정했는데, 웹훅과 폴링이 같은 취소를
// 동시에 처리하면 둘 다 order_state==='COMPLETED'를 읽어버려 재고를 두 번 복구(이중 복구)할 수
// 있었다. UPDATE는 대상 행을 실제로 잠그므로, 동시에 같은 취소를 보는 두 트랜잭션 중 먼저
// 커밋하는 쪽만 1행을 얻고(ingestCompletedOrder의 소유권 판정과 같은 원리), 나머지는 재평가 시
// 이미 CANCELLED로 바뀐 뒤라 0행을 얻어 재고 복구를 건너뛴다.
async function reverseCancelledOrder(trx, store, order) {
  const orderId = String(order.id);

  const won = await trx('orders')
    .where({ toss_order_id: orderId, store_id: store.id })
    .where('order_state', 'COMPLETED')
    .update({
      order_state: 'CANCELLED',
      list_price: 0, discount_amount: 0, supply_amount: 0, total_amount: 0,
      cash_amount: 0, card_amount: 0, other_amount: 0,
    });

  if (won !== 1) {
    // 행이 아예 없거나, 이미 CANCELLED(처음부터 취소였거나 다른 트랜잭션이 방금 먼저 되돌림)라
    // 재고를 건드리지 않는다. 이미 CANCELLED인 행은 이미 0원으로 맞춰져 있으므로 다시 쓸 필요가 없다.
    //
    // 예외: order_state 컬럼이 생기기 전에 들어온 레거시 행(NULL)이나 예상 밖의 상태값. 재고를 깎은
    // 기록이 확실하지 않으니 복구는 하지 않되, 예전 코드가 그랬듯 CANCELLED·0원으로는 맞춰 둔다 —
    // 안 그러면 취소된 주문이 대시보드 매출 집계에 계속 남는다.
    await trx('orders')
      .where({ toss_order_id: orderId, store_id: store.id })
      .where(b => b.whereNull('order_state').orWhereNotIn('order_state', ['COMPLETED', 'CANCELLED', 'INGESTING']))
      .update({
        order_state: 'CANCELLED',
        list_price: 0, discount_amount: 0, supply_amount: 0, total_amount: 0,
        cash_amount: 0, card_amount: 0, other_amount: 0,
      });
    return { reversed: false, issues: newIssues() };
  }

  // 여기부터는 이 트랜잭션이 COMPLETED→CANCELLED 전환의 소유권을 얻은 경우뿐이다 — 재고를
  // 실제로 깎은 적이 있으므로 복구를 진행한다. raw_payload는 방금 update에서 건드리지 않았으니
  // 그대로 다시 읽어도 안전하다.
  const original = await trx('orders').where({ toss_order_id: orderId, store_id: store.id }).first();
  const lineItems = (order.lineItems && order.lineItems.length > 0)
    ? order.lineItems
    : extractLineItemsFromRawPayload(original.raw_payload);
  const issues = newIssues();
  await adjustStock(trx, lineItems, -1, store, orderId, issues);
  await trx('sales_items').where({ toss_order_id: orderId, store_id: store.id }).delete();

  return { reversed: true, issues };
}

module.exports = {
  ingestCompletedOrder,
  reverseCancelledOrder,
  emitRiskNotifications,
};
