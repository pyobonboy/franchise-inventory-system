// 발주 상태 관련 상수의 정본(클라이언트 쪽).
// 이 값은 server/src/constants.js(ORDER_STATUSES, PURCHASE_ORDER_ITEM_STATUSES)와
// server/src/orderStatusFlow.js(ALLOWED_TRANSITIONS)와 짝을 이룬다. 서버 값이 바뀌면 여기도 같이 바꿀 것.
// 예전엔 STATUS_LABEL이 HQOrders/StoreOrder/OrderInvoice 3곳에 복사돼 있었고 STATUS_COLOR는 2곳의 값이
// 서로 달라 같은 상태가 화면마다 다른 색으로 보였다.

export const STATUS_LABEL = {
  DRAFT: '임시저장', ORDERED: '발주완료', REVIEWING: '검토중',
  REVISION_REQUESTED: '수정요청', CONFIRMED: '주문확정',
  PAYMENT_PENDING: '결제대기', PAID: '결제완료',
  PREPARING_SHIPMENT: '출고준비', SHIPPED: '출고완료',
  DELIVERED: '납품완료', CLOSED: '주문종료', CANCELED: '주문취소',
};

// HQOrders.jsx 값을 정본으로 채택(StoreOrder.jsx 쪽 불일치 값 폐기)
export const STATUS_COLOR = {
  DRAFT: '#94a3b8', ORDERED: '#6366f1', REVIEWING: '#f59e0b',
  REVISION_REQUESTED: '#ef4444', CONFIRMED: '#06b6d4',
  PAYMENT_PENDING: '#f97316', PAID: '#22c55e',
  PREPARING_SHIPMENT: '#8b5cf6', SHIPPED: '#3b82f6',
  DELIVERED: '#16a34a', CLOSED: '#64748b', CANCELED: '#ef4444',
};

// 서버 orderStatusFlow.js의 ALLOWED_TRANSITIONS와 값이 같아야 한다. 바꿀 땐 양쪽 다 고칠 것.
// 서버가 같은 표로 검증하므로 화면은 "다음 단계"만 노출하는 용도다.
// 결제 완료 이후 발주서를 상태변경으로 취소하면 토스 환불 없이 status만 바뀌어 정산에는 매출로
// 남고 재고 원복도 안 된다 — 서버(orderStatusFlow.js)에서 그 전이를 없앴다. 결제 후 취소는
// 환불(POST /:id/refund 전액)만이 정당한 경로다.
export const NEXT_STATUSES = {
  DRAFT: ['ORDERED', 'CANCELED'],
  ORDERED: ['REVIEWING', 'CONFIRMED', 'REVISION_REQUESTED', 'CANCELED'],
  REVIEWING: ['CONFIRMED', 'REVISION_REQUESTED', 'CANCELED'],
  REVISION_REQUESTED: ['ORDERED', 'CONFIRMED', 'CANCELED'],
  CONFIRMED: ['PAYMENT_PENDING', 'CANCELED'],
  // PAYMENT_PENDING → PAID를 뺐다. 정상 결제는 payment/confirm이 paid_at/toss_payment_key와 함께
  // 직접 status를 PAID로 바꾸므로 화면의 상태변경 드롭다운에 노출될 필요가 없다 — 서버(orderStatusFlow.js)
  // 도 이 전이를 없앴다.
  PAYMENT_PENDING: ['CONFIRMED', 'CANCELED'],
  PAID: ['PREPARING_SHIPMENT', 'SHIPPED'],
  PREPARING_SHIPMENT: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: ['CLOSED'],
  CLOSED: [],
  CANCELED: [],
};

// server/src/constants.js의 PURCHASE_ORDER_ITEM_STATUSES와 동일. 예전에 StoreOrder.jsx가 'SOLD_OUT'이라는
// 존재하지 않는 값을 검사해서 가맹점 화면에 품절 배지가 단 한 번도 뜨지 않았다.
export const ITEM_STATUS = { NORMAL: 'NORMAL', OUT_OF_STOCK: 'OUT_OF_STOCK', SUBSTITUTED: 'SUBSTITUTED' };

export const ACTIVE_STATUSES = ['ORDERED', 'REVIEWING', 'REVISION_REQUESTED', 'CONFIRMED', 'PAYMENT_PENDING', 'PAID', 'PREPARING_SHIPMENT', 'SHIPPED'];
export const DONE_STATUSES = ['DELIVERED', 'CLOSED', 'CANCELED'];
