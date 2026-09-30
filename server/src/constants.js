// DB 상태/분류 값의 단일 참조 지점. 값 자체는 기존 스키마와 라우트에서 사용하던 문자열을 유지한다.
const ORDER_STATUSES = Object.freeze({
  DRAFT: 'DRAFT',
  ORDERED: 'ORDERED',
  REVIEWING: 'REVIEWING',
  REVISION_REQUESTED: 'REVISION_REQUESTED',
  CONFIRMED: 'CONFIRMED',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAID: 'PAID',
  PREPARING_SHIPMENT: 'PREPARING_SHIPMENT',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CLOSED: 'CLOSED',
  CANCELED: 'CANCELED',
});

const PAYMENT_STATUSES = Object.freeze({
  NOT_REQUESTED: 'NOT_REQUESTED',
  REQUESTED: 'REQUESTED',
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
});

const RISK_TYPES = Object.freeze({
  OVER_PURCHASE: 'OVER_PURCHASE',
  // 판매량 대비 발주가 부족함 = 재료를 본사가 아닌 다른 곳에서 조달했을 가능성(사입).
  // 이 시스템의 사업적 목적 중 하나가 사입 감시라 OVER_PURCHASE보다 오히려 더 중요한 신호다.
  UNDER_PURCHASE: 'UNDER_PURCHASE',
  SALES_DOWN_ORDER_UP: 'SALES_DOWN_ORDER_UP',
  LOW_TURNOVER: 'LOW_TURNOVER',
  HIGH_WASTE: 'HIGH_WASTE',
  STORE_OUTLIER: 'STORE_OUTLIER',
  PAYMENT_OVERDUE: 'PAYMENT_OVERDUE',
  LOW_STOCK: 'LOW_STOCK',
  // 아래 4개는 "장사 리스크"가 아니라 시스템이 제 역할을 못 하고 있다는 신호다. 지금까지 이런 실패는
  // console 로그로만 남아 아무도 보지 않았는데, 그 사이 재고·매출 데이터가 조용히 틀어진다.
  // 기존 리스크 알림 화면에 함께 띄워서 운영자가 알아챌 수 있게 한다.
  MENU_UNMATCHED: 'MENU_UNMATCHED',     // POS 메뉴명이 등록된 메뉴와 안 맞아 재고가 차감되지 않음
  NEGATIVE_STOCK: 'NEGATIVE_STOCK',     // 재고가 음수로 내려감 (레시피 수량 오류 등)
  WEBHOOK_REJECTED: 'WEBHOOK_REJECTED', // 웹훅이 거부되어 매출이 유입되지 않음
  SYNC_FAILED: 'SYNC_FAILED',           // 토스플레이스 매출 동기화가 연속 실패
  REFUND_INCONSISTENT: 'REFUND_INCONSISTENT',       // 토스 환불은 성공했으나 DB 반영 트랜잭션이 실패 — 수동 대사 필요
  SALES_REINGEST_BLOCKED: 'SALES_REINGEST_BLOCKED', // 취소 처리된 주문이 COMPLETED로 재유입되어 반영을 차단함
});

const RISK_SEVERITIES = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
});

const RISK_STATUSES = Object.freeze({
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
});

const STOCK_LEDGER_TYPES = Object.freeze({
  DELIVERY: 'DELIVERY',
  REFUND: 'REFUND',
  SALE: 'SALE',
  SALE_CANCEL: 'SALE_CANCEL',
  WASTE: 'WASTE',
  WASTE_CANCEL: 'WASTE_CANCEL',
  ADJUSTMENT: 'ADJUSTMENT',
});

const PURCHASE_ORDER_ITEM_STATUSES = Object.freeze({
  NORMAL: 'NORMAL',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  SUBSTITUTED: 'SUBSTITUTED',
});

// 사입 감시 판정 임계값. api.js의 /analytics(리스크 자동 생성)와 /purchase-anomalies(화면 집계)가
// 서로 다른 하드코딩 값을 쓰면 "화면엔 안 뜨는데 알림만 온다"는 어긋남이 생긴다.
const PURCHASE_RATIOS = Object.freeze({ OVER: 2.0, UNDER: 0.7 });

module.exports = {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  RISK_TYPES,
  RISK_SEVERITIES,
  RISK_STATUSES,
  STOCK_LEDGER_TYPES,
  PURCHASE_ORDER_ITEM_STATUSES,
  PURCHASE_RATIOS,
};
