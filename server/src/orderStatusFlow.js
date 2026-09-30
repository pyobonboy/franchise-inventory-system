// 발주 상태 전이표 — 표의 근거는 실제 화면 흐름: `client/src/pages/HQOrders.jsx`의 상태 드롭다운과
// `StoreOrder.jsx`의 결제/취소 버튼이다. 여기 없는 전이는 화면에도 없는 조작이므로 API에서도 막는다.
// PAID 이후 → CANCELED를 뺐다. 결제 완료 발주서를 상태변경 API로 취소하면 토스 환불 없이 `status`만
// CANCELED가 되어 정산(`/settlement`, `paid_at` 기준)에는 매출로 남고 재고 원복도 안 된다. 결제 후
// 취소는 `POST /:id/refund`(전액)만이 정당한 경로이고, 그 라우트는 전이표를 거치지 않고 직접
// `status: CANCELED`를 쓴다. 화면(HQOrders 드롭다운)은 원래 CANCELED를 필터링하므로 노출 변화는 없다.
const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT:              ['ORDERED', 'CANCELED'],
  ORDERED:            ['REVIEWING', 'CONFIRMED', 'REVISION_REQUESTED', 'CANCELED'],
  REVIEWING:          ['CONFIRMED', 'REVISION_REQUESTED', 'CANCELED'],
  REVISION_REQUESTED: ['ORDERED', 'CONFIRMED', 'CANCELED'],
  CONFIRMED:          ['PAYMENT_PENDING', 'CANCELED'],
  // PAYMENT_PENDING → PAID를 뺐다. 정상 결제는 POST /:id/payment/confirm이 전이표를 거치지 않고
  // paid_at/toss_payment_key를 함께 세우며 직접 status: PAID를 쓴다. 이 상태변경 API로 PAID를 보내면
  // 그 필드들이 비워진 채로 상태만 바뀌어, DELIVERED(paid_at 필요)·환불(toss_payment_key 필요)·
  // 취소(PAID 이후 CANCELED는 위에서 이미 제거됨)·DELETE가 전부 막혀 DB를 직접 고치는 것 외엔 복구가 안 된다.
  PAYMENT_PENDING:    ['CONFIRMED', 'CANCELED'],
  PAID:               ['PREPARING_SHIPMENT', 'SHIPPED'],
  PREPARING_SHIPMENT: ['SHIPPED'],
  SHIPPED:            ['DELIVERED'],
  DELIVERED:          ['CLOSED'],
  CLOSED:             [],
  CANCELED:           [],
});

// from === to는 항상 허용(멱등 호출) — 재시도/중복 클릭으로 같은 상태를 다시 요청해도 막지 않는다
function canTransition(from, to) {
  if (from === to) return true;
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

module.exports = { ALLOWED_TRANSITIONS, canTransition };
