// 토스플레이스 주문 원본(raw_payload)에서 대시보드/정산에 필요한 금액 필드를 뽑아내는 공용 헬퍼.
// 수신 경로에 따라 구조가 다름: 웹훅은 { data: { order: {...} } } 형태로 감싸져 오고,
// REST 동기화(syncStoreSales)는 order 객체가 바로 최상위에 옴 — 두 경우를 모두 처리.
function getOrderNode(payload) {
  return payload?.data?.order || payload;
}

function extractOrderFinance(payload) {
  const order = getOrderNode(payload) || {};
  const cp = order.chargePrice || {};
  const payments = order.payments || [];

  let cash = 0, card = 0, other = 0;
  for (const p of payments) {
    const amt = Number(p.amount) || 0;
    if (p.paymentMethod === 'CASH') cash += amt;
    else if (p.paymentMethod === 'CARD') card += amt;
    else other += amt;
  }

  return {
    order_state: order.orderState || null,
    list_price: Number(cp.listPrice) || 0,
    discount_amount: Number(cp.discountAmount) || 0,
    supply_amount: Number(cp.supplyAmount) || 0,
    total_amount: Number(cp.totalAmount) || 0,
    cash_amount: cash,
    card_amount: card,
    other_amount: other,
  };
}

module.exports = { getOrderNode, extractOrderFinance };
