'use strict';

// 판매 기록(sales_items)에는 토스가 주문마다 함께 보내주는 메뉴 고유 ID(item.item.id, DB 컬럼명
// sales_items.toss_menu_id)가 이미 쌓여 있다. 하지만 menus.toss_menu_id는 사람이 손으로 채워야
// 해서 대부분 비어 있고, 그 결과 판매↔메뉴 매칭이 사실상 "이름 문자열 비교"에 의존하게 된다.
// 가맹점이 POS에서 메뉴 이름만 바꾸면 이 매칭이 통째로 빠지고(레시피 기반 예상 소진량 계산에서
// 그 판매가 제외됨), 사입 감시를 그대로 회피할 수 있다.
//
// 여기 두 함수는 "새 API를 호출"하는 게 아니라 "이미 들어와 있는 ID를 menus에 연결"하는 역할만
// 한다.
//   - backfillMenuTossIds: 서버 기동 시 1회, 이미 쌓인 sales_items를 근거로 과거분을 채운다(index.js).
//   - linkMenuToTossId: 새 판매가 들어올 때마다, 이름으로 메뉴를 찾은 김에 그 자리에서 연결해둔다
//     (webhook.js의 adjustStock). 트랜잭션 안에서 호출될 수 있으므로 knex 인스턴스가 아니라
//     호출부가 넘겨주는 queryable(knex 또는 trx)을 그대로 쓴다 — 직접 require('./db/schema')의
//     knex를 잡아 쓰면 이미 열린 트랜잭션과 커넥션을 다투다 교착 상태에 빠질 수 있다(SQLite는
//     커넥션 풀이 1개뿐, CLAUDE.md 4절).

// 메뉴 한 곳에 toss_menu_id 하나를 연결한다. 아래 두 안전장치를 반드시 지킨다:
//  1) menu.toss_menu_id가 이미 채워져 있으면 절대 덮어쓰지 않는다 — 사람이 손으로 맞춰둔 값일 수 있다.
//  2) 같은 가맹점 안에서 이 ID가 이미 다른 메뉴 행에 붙어있으면 연결하지 않는다 — ID 하나가 메뉴
//     두 개를 동시에 가리키게 되면(예: 메뉴 이름이 바뀌면서 새 메뉴 행이 만들어진 경우) ID로 조회할 때
//     어느 행이 걸릴지 알 수 없어져 "ID 우선 매칭"이 오히려 엉뚱한 재고를 깎을 위험이 생긴다.
// 반환값: 실제로 연결했으면 true, 아니면 false (호출부가 로그/집계에 쓸 수 있게).
async function linkMenuToTossId(queryable, menu, tossMenuId) {
  if (!menu || !tossMenuId) return false;
  if (menu.toss_menu_id) return false;

  const conflicting = await queryable('menus')
    .where({ store_id: menu.store_id, toss_menu_id: tossMenuId })
    .whereNot({ id: menu.id })
    .first();
  if (conflicting) {
    console.warn(
      `[메뉴연결] toss_menu_id=${tossMenuId}가 이미 다른 메뉴(id=${conflicting.id}, "${conflicting.name}")에 ` +
      `연결되어 있어 "${menu.name}"(id=${menu.id})에는 연결하지 않았습니다. 운영자 확인 필요.`
    );
    return false;
  }

  await queryable('menus').where({ id: menu.id }).update({ toss_menu_id: tossMenuId });
  return true;
}

// 이미 쌓인 sales_items를 근거로 menus.toss_menu_id를 채운다. index.js에서 기동마다 1회 호출된다
// (credentialsBackfill.js와 같은 "자기 치유 백필" 패턴 — 실패해도 서버 기동을 막지 않도록 이 함수
// 안에서 예외를 전부 삼킨다).
async function backfillMenuTossIds(knex) {
  try {
    // (store_id, menu_name, toss_menu_id) 조합별로 몇 건/가장 최근 판매 시각을 모은다. 같은 이름이
    // 여러 ID로 팔린 적이 있으면 이 조합이 이름당 여러 행으로 갈라져 나온다 — 그게 바로 "한 이름에
    // ID가 여럿" 케이스를 골라내는 방법이다.
    const rows = await knex('sales_items')
      .whereNotNull('toss_menu_id')
      .andWhere('toss_menu_id', '<>', '')
      .select('store_id', 'menu_name', 'toss_menu_id')
      .max({ last_sold_at: 'sold_at' })
      .count({ cnt: 'id' })
      .groupBy('store_id', 'menu_name', 'toss_menu_id');

    // 이름 -> 관측된 (id, 통계) 목록
    const byName = new Map();
    for (const r of rows) {
      const key = `${r.store_id}::${r.menu_name}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(r);
    }

    // 한 이름에 서로 다른 ID가 여러 개 관측된 경우 — 어느 게 맞는 메뉴인지 알 수 없다. 잘못 연결하면
    // 엉뚱한 재고가 깎이는 사고로 이어지므로, 이런 이름은 연결 후보에서 아예 제외하고 로그만 남겨
    // 운영자가 직접 확인하게 한다(예: 서로 다른 두 POS 품목이 우연히 같은 이름으로 등록된 경우).
    const ambiguousNames = [];
    const cleanRows = [];
    for (const [key, group] of byName) {
      if (group.length > 1) {
        ambiguousNames.push(`${key} -> [${group.map(g => g.toss_menu_id).join(', ')}]`);
      } else {
        cleanRows.push(group[0]);
      }
    }
    if (ambiguousNames.length > 0) {
      console.warn(
        `[메뉴연결백필] ${ambiguousNames.length}개 메뉴명이 서로 다른 toss_menu_id로 팔린 기록이 있어 ` +
        `자동 연결하지 않았습니다 (운영자 확인 필요): ${ambiguousNames.join(' / ')}`
      );
    }

    // 이름 충돌이 없는 나머지에서, 반대로 하나의 ID가 여러 이름에 걸쳐 나타나는 경우도 있다 — 이건
    // 오히려 정상이다(POS에서 메뉴 이름을 바꾼 이력, 또는 이번 작업이 막으려는 바로 그 회피 시도의
    // 흔적). menus.toss_menu_id는 ID 하나당 메뉴 행 하나에만 붙어야 하므로(그래야 ID로 조회할 때
    // 어느 행이 걸릴지 모호해지지 않는다), 이런 ID는 "가장 최근에 그 이름으로 팔린" 쪽, 즉 현재
    // 이름일 가능성이 가장 높은 그룹 하나만 연결 후보로 남기고 나머지 과거 이름은 이력으로만 로그에 남긴다.
    const byId = new Map();
    for (const r of cleanRows) {
      const key = `${r.store_id}::${r.toss_menu_id}`;
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(r);
    }

    const candidates = [];
    const renameHistory = [];
    for (const group of byId.values()) {
      if (group.length === 1) {
        candidates.push(group[0]);
        continue;
      }
      group.sort((a, b) => new Date(b.last_sold_at) - new Date(a.last_sold_at));
      candidates.push(group[0]);
      renameHistory.push(
        `store=${group[0].store_id} id=${group[0].toss_menu_id}: [${group.slice(1).map(g => g.menu_name).join(', ')}] -> ${group[0].menu_name}`
      );
    }
    if (renameHistory.length > 0) {
      console.log(
        `[메뉴연결백필] 이름 변경 이력으로 보이는 ${renameHistory.length}건 감지 — 가장 최근에 팔린 이름에만 연결합니다: ${renameHistory.join(' / ')}`
      );
    }

    let linked = 0;
    for (const c of candidates) {
      const menu = await knex('menus').where({ store_id: c.store_id, name: c.menu_name }).first();
      if (!menu) continue; // 우리 쪽에 등록조차 안 된 메뉴명 — 연결할 대상이 없다
      const didLink = await linkMenuToTossId(knex, menu, c.toss_menu_id);
      if (didLink) linked++;
    }

    // 0건이면 조용히 넘어간다 — 위의 경고/정보 로그(ambiguousNames, renameHistory)는 실제로 뭔가
    // 발견됐을 때만 이미 찍히므로 별개로 취급.
    if (linked > 0) {
      console.log(`[메뉴연결백필] menus.toss_menu_id ${linked}건 자동 연결 완료`);
    }
  } catch (e) {
    // 백필 실패가 서버 기동을 막으면 안 된다 — credentialsBackfill.js와 동일한 원칙.
    console.error('[메뉴연결백필] 오류:', e.message);
  }
}

module.exports = { backfillMenuTossIds, linkMenuToTossId };
