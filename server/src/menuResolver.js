'use strict';

// "메뉴 하나가 재료를 얼마나 먹는지" 계산하는 단 하나의 진실.
//
// 왜 필요한가: 이 계산(레시피 역산)이 지금까지 웹훅의 재고 차감(routes/webhook.js)과 사입 계산
// (routes/api.js의 getIngredientComparison)에 각각 따로 있었다. 표준 메뉴 연결(recipe_source_menu_id)과
// 세트메뉴(menu_components)가 생기면서 이 계산이 재귀적으로 복잡해지는데, 두 군데에 각각 구현하면
// 언젠가 반드시 어긋난다 — 그리고 그 어긋남이 그대로 사입(가맹점이 본사 대신 다른 데서 재료를 사는
// 것) 감시의 새 회피 경로가 된다(세트 레시피 계산이 웹훅에서만 맞고 분석 화면에서는 0으로 나오면,
// 발주 부족 알림이 안 뜨는 식으로). 그래서 이 파일 하나만 두고 양쪽 다 이 파일을 쓰게 한다.
//
// 계산 규칙 (resolveConsumption/resolveConsumptionBulk 공통):
//   1. 이 메뉴에 recipes가 있으면 그걸 쓴다.
//   2. recipes가 없고 recipe_source_menu_id가 있으면 그 메뉴의 레시피를 쓴다(그 메뉴도 같은
//      규칙을 적용받는다 — 표준 메뉴가 또 다른 표준 메뉴를 가리키는 체인도 허용).
//   3. menu_components에 구성이 있으면 각 구성 메뉴를 같은 규칙으로 재귀 계산해서 더한다(수량
//      곱셈). 세트 자신의 레시피(1번)가 있으면 그것도 함께 더한다 — 세트 전용 재료(단무지,
//      포장용기 등)가 실제로 존재하므로 "구성이 있으면 자기 레시피 무시"는 틀린 규칙이다.
//   4. 순환 참조(세트 A가 B를 품고 B가 A를 품는 등)는 "방문 중인 메뉴 id" 집합으로 감지해서
//      에러를 던진다 — 조용히 넘어가면 계산이 원래 값보다 작게 나오고(무한히 돌기 전에 어디선가
//      멈추는 방식이라면) 그게 또 다른 사입 회피 경로가 된다. 감지 즉시 예외를 던져 호출부가
//      트랜잭션을 롤백하거나 명확히 실패하게 한다. 방문 집합만으로는 못 잡는(순환은 아니지만
//      비정상적으로 긴 체인) 경우를 대비해 깊이 제한도 별도로 둔다(워치독 이중화).
//   5. 아무것도 못 찾으면(메뉴 자체가 없거나, 레시피/표준메뉴/구성이 전부 비어있으면) 빈
//      배열/빈 Map을 반환한다 — 호출부가 "레시피 없음"으로 판단해 알림을 띄울 수 있게 한다.
//
// 성능: resolveConsumptionBulk는 판매 종류(서로 다른 메뉴)마다 쿼리를 날리지 않는다. 먼저 관련된
// 모든 메뉴 id를 BFS로 넓혀가며 필요한 recipes/menu_components/menus를 각각 whereIn 한 번씩만
// 불러 메모리에 그래프를 만든 뒤, 그 그래프 위에서 각 판매 건을 순회하며 계산한다.

// 방문 집합이 순환을 못 잡는 극단적인 경우(체인이 계속 새 메뉴로 이어지기만 하고 순환은 안 하는
// 경우)를 대비한 이중 안전장치. 실제 세트 구성이 이 깊이를 넘을 일은 없다 — 넘으면 그 자체가
// 데이터 이상(순환이거나 잘못 등록된 체인)이라는 신호다.
const MAX_DEPTH = 10;

function addTo(map, ingredientId, amount) {
  map.set(ingredientId, (map.get(ingredientId) || 0) + amount);
}

// rootMenus에서 출발해 recipe_source_menu_id / menu_components가 가리키는 메뉴를 BFS로 넓혀가며
// 계산에 필요한 데이터를 메모리에 모은다. 쿼리는 단계(깊이)마다 최대 3번(recipes/menu_components/menus
// whereIn)만 나가고, 같은 메뉴 id를 두 번 조회하지 않는다.
async function buildGraph(queryable, rootMenus) {
  const menusById = new Map(); // menu_id -> menu row(최소 id, recipe_source_menu_id) | null(존재하지 않음)
  for (const m of rootMenus) {
    if (m && m.id != null) menusById.set(m.id, m);
  }

  const recipesByMenu = new Map(); // menu_id -> [{ ingredient_id, amount }]
  const componentsBySet = new Map(); // set_menu_id -> [{ component_menu_id, quantity }]

  let frontier = [...menusById.keys()];
  let depth = 0;

  while (frontier.length > 0) {
    depth += 1;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `menuResolver: 메뉴 관계 그래프가 최대 깊이(${MAX_DEPTH})를 초과했습니다 — ` +
        `menu_components/recipe_source_menu_id 순환 참조 또는 비정상적으로 긴 체인이 의심됩니다. ` +
        `frontier=[${frontier.join(',')}]`
      );
    }

    const needRecipes = frontier.filter((id) => !recipesByMenu.has(id));
    if (needRecipes.length > 0) {
      const rows = await queryable('recipes').whereIn('menu_id', needRecipes).select('menu_id', 'ingredient_id', 'amount');
      for (const id of needRecipes) recipesByMenu.set(id, []);
      for (const r of rows) recipesByMenu.get(r.menu_id).push({ ingredient_id: r.ingredient_id, amount: r.amount });
    }

    const needComponents = frontier.filter((id) => !componentsBySet.has(id));
    if (needComponents.length > 0) {
      const rows = await queryable('menu_components')
        .whereIn('set_menu_id', needComponents)
        .select('set_menu_id', 'component_menu_id', 'quantity');
      for (const id of needComponents) componentsBySet.set(id, []);
      for (const r of rows) componentsBySet.get(r.set_menu_id).push({ component_menu_id: r.component_menu_id, quantity: r.quantity });
    }

    // 다음 단계에서 새로 읽어야 할 메뉴 id: (a) 자기 레시피가 없어 recipe_source_menu_id를
    // 따라가야 하는 경우, (b) 구성 메뉴 id — 아직 menusById에 없는 것만.
    const nextIds = new Set();
    for (const id of frontier) {
      const menu = menusById.get(id);
      const recipes = recipesByMenu.get(id) || [];
      if (recipes.length === 0 && menu && menu.recipe_source_menu_id && !menusById.has(menu.recipe_source_menu_id)) {
        nextIds.add(menu.recipe_source_menu_id);
      }
      for (const c of (componentsBySet.get(id) || [])) {
        if (!menusById.has(c.component_menu_id)) nextIds.add(c.component_menu_id);
      }
    }

    if (nextIds.size === 0) break;

    const idsArr = [...nextIds];
    const rows = await queryable('menus').whereIn('id', idsArr).select('id', 'recipe_source_menu_id');
    for (const m of rows) menusById.set(m.id, m);
    // 참조는 있는데 실제로 존재하지 않는 메뉴(삭제된 메뉴 등) — null로 표시해 다음 루프에서
    // 다시 조회 시도하지 않게 한다. walk()에서는 "메뉴 없음"과 동일하게 취급되어 기여분 0.
    for (const id of idsArr) if (!menusById.has(id)) menusById.set(id, null);
    frontier = idsArr.filter((id) => menusById.get(id));
  }

  return { menusById, recipesByMenu, componentsBySet };
}

// graph 위에서 menuId 1개(quantity개 판매됨)의 재료 소모를 resultMap(ingredient_id -> amount)에 누적한다.
// visiting은 이번 top-level 호출(resolveConsumption 1번 또는 resolveConsumptionBulk의 판매 1건) 안에서만
// 유효한 "현재 경로에 들어있는 메뉴 id" 집합이다 — 판매 건마다 새로 시작해야 하므로 호출부가 매번 새
// Set을 넘긴다.
function walk(menuId, quantity, graph, visiting, resultMap, depth) {
  if (depth > MAX_DEPTH) {
    throw new Error(`menuResolver: 메뉴 id=${menuId} 계산이 최대 깊이(${MAX_DEPTH})를 초과했습니다.`);
  }
  if (visiting.has(menuId)) {
    // 조용히 넘어가지 않는다 — 순환을 만나고도 계산을 계속하면 "일부만 반영된 소진량"이 나와
    // 오히려 사입 감시를 왜곡한다(과소평가된 예상 소진량은 발주부족 오탐/누락으로 이어진다).
    throw new Error(
      `menuResolver: menu_id=${menuId}에서 순환 참조가 감지되었습니다 ` +
      `(방문 경로: ${[...visiting, menuId].join(' -> ')}). menu_components 또는 ` +
      `recipe_source_menu_id 설정을 확인하세요.`
    );
  }

  visiting.add(menuId);
  try {
    const recipes = graph.recipesByMenu.get(menuId) || [];
    if (recipes.length > 0) {
      // 규칙 1: 자기 레시피가 있으면 그걸 쓴다.
      for (const r of recipes) addTo(resultMap, r.ingredient_id, r.amount * quantity);
    } else {
      // 규칙 2: 자기 레시피가 없으면 표준 메뉴(recipe_source_menu_id)의 레시피를 대신 쓴다.
      const menu = graph.menusById.get(menuId);
      const sourceId = menu && menu.recipe_source_menu_id;
      if (sourceId) walk(sourceId, quantity, graph, visiting, resultMap, depth + 1);
    }

    // 규칙 3: 구성 메뉴(세트)는 자기 레시피 유무와 무관하게 항상 함께 더한다.
    const comps = graph.componentsBySet.get(menuId) || [];
    for (const c of comps) {
      walk(c.component_menu_id, quantity * c.quantity, graph, visiting, resultMap, depth + 1);
    }
  } finally {
    visiting.delete(menuId);
  }
}

// 판매 1건이 소모하는 재료를 계산한다.
// queryable: knex 또는 trx (호출부가 트랜잭션 안이면 반드시 trx를 넘긴다 — SQLite는 커넥션 풀이
// 1개뿐이라 이미 열린 트랜잭션 안에서 knex(...)를 쓰면 교착 상태에 빠진다, CLAUDE.md 4절)
// menu: menus 행(이미 찾아둔 것) — 최소 id, recipe_source_menu_id가 있어야 한다.
// quantity: 판매 수량
// 반환: [{ ingredient_id, amount }] — 세트면 구성 메뉴까지 펼친 합계. 같은 재료가 자기 레시피와
// 구성 메뉴 양쪽에서(또는 여러 구성 메뉴에서) 나오면 하나로 합산된 값 하나만 돌려준다.
async function resolveConsumption(queryable, menu, quantity) {
  if (!menu || menu.id == null) return [];
  const graph = await buildGraph(queryable, [menu]);
  const resultMap = new Map();
  walk(menu.id, quantity, graph, new Set(), resultMap, 0);
  return [...resultMap.entries()].map(([ingredient_id, amount]) => ({ ingredient_id, amount }));
}

// 여러 판매를 한 번에 집계한다(분석/사입 계산용, N+1 쿼리 회피).
// sales: [{ menu, quantity }] — menu는 menus 행(또는 null/undefined — 매칭 실패한 건은 그냥 건너뛴다)
// 반환: Map<ingredient_id, amount> — 모든 판매 건을 합산한 값.
async function resolveConsumptionBulk(queryable, sales) {
  const rootMenus = sales.map((s) => s && s.menu).filter(Boolean);
  const graph = await buildGraph(queryable, rootMenus);

  const resultMap = new Map();
  for (const sale of sales) {
    if (!sale || !sale.menu || sale.menu.id == null) continue;
    // 방문 집합은 판매 건마다 새로 시작한다 — 같은 메뉴가 서로 다른 판매 건에 여러 번 등장하는 것은
    // 정상(사고 순환이 아니다)이고, 한 판매 건의 경로 안에서만 순환을 판별해야 한다.
    walk(sale.menu.id, sale.quantity, graph, new Set(), resultMap, 0);
  }
  return resultMap;
}

module.exports = { resolveConsumption, resolveConsumptionBulk };
