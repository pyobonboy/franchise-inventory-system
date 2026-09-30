const { knex } = require('./db/schema');

// 재료 재고가 바뀌는 모든 경로(발주 납품/환불, 판매 차감, 폐기, 실사조정)를 한 테이블에 기록해서
// "상품별 거래 수불"(특정 재료가 언제 얼마나 들어오고 나갔는지) 조회를 가능하게 한다.
async function logStockMovement(trx, { brand_id, store_id, ingredient_id, type, delta, before_stock, after_stock, memo, ref_type, ref_id, created_by }) {
  const q = trx || knex;
  await q('stock_ledger').insert({
    brand_id, store_id, ingredient_id, type,
    quantity_delta: delta, before_stock, after_stock,
    memo: memo || null, ref_type: ref_type || null, ref_id: ref_id || null,
    created_by: created_by || null,
  });
}

module.exports = { logStockMovement };
