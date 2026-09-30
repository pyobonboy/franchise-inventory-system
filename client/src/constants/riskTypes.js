// 리스크 알림 타입 라벨의 정본(클라이언트 쪽). server/src/constants.js의 RISK_TYPES 14종과 짝을 이룬다.
// 서버에 타입을 추가하면 여기에도 한국어 라벨을 추가할 것 — 없으면 화면에 타입 문자열이 영문 그대로 노출된다
// (riskTypeLabel의 폴백이 있어 깨지지는 않음).
// 예전엔 Risks.jsx와 Dashboard.jsx가 각자 복사본을 들고 있었고 Dashboard 쪽은 5종이 빠져 있었다.

export const RISK_TYPE_LABEL = {
  OVER_PURCHASE: '과다 사입',
  UNDER_PURCHASE: '발주 부족(사입 의심)',
  SALES_DOWN_ORDER_UP: '매출감소·발주증가',
  LOW_TURNOVER: '저회전 식자재',
  HIGH_WASTE: '폐기 과다',
  STORE_OUTLIER: '유사 매장 대비 이상',
  PAYMENT_OVERDUE: '결제 미완료',
  LOW_STOCK: '재고 부족',
  // 아래는 장사 리스크가 아니라 "시스템이 제 역할을 못 하고 있다"는 신호다.
  MENU_UNMATCHED: '메뉴 미연결 · 재고 미차감',
  NEGATIVE_STOCK: '재고 음수',
  WEBHOOK_REJECTED: '웹훅 거부 · 매출 유입 중단',
  SYNC_FAILED: '매출 동기화 실패',
  // 환불/재유입 관련 데이터 정합성 신호
  REFUND_INCONSISTENT: '환불 반영 불일치 · 수동 확인 필요',
  SALES_REINGEST_BLOCKED: '취소 주문 재유입 차단',
};

export const RISK_SEVERITY_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#6366f1' };

export const riskTypeLabel = (t) => RISK_TYPE_LABEL[t] || t;
