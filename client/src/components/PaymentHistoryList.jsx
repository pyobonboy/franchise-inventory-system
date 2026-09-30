const won = (v) => `${Math.round(v || 0).toLocaleString()}원`;

// 가맹점 결제내역 — 토스포스 앱 "결제내역" 화면과 같은 성격의 목록. Stores.jsx(가맹점 상세)와
// Dashboard.jsx(전주/전일 매출현황 옆)에서 공용으로 씀.
export default function PaymentHistoryList({ payments, limit = 10 }) {
  if (!payments || payments.length === 0) return <div className="empty p-3">결제내역 없음</div>;

  return (
    <div>
      {payments.slice(0, limit).map(p => (
        <div key={p.id} className="flex justify-between items-center text-[12.5px] py-1.5 border-b border-line gap-2">
          <div className="text-fg-2 min-w-0">
            <div className="overflow-hidden text-ellipsis whitespace-nowrap">{p.summary}</div>
            <div className="text-muted text-2xs">
              {new Date(p.processed_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              {p.cardLabel && <span> · {p.cardLabel}</span>}
            </div>
          </div>
          <div className="flex flex-col items-end shrink-0">
            <span style={{ textDecoration: p.status === 'CANCELLED' ? 'line-through' : 'none', color: p.status === 'CANCELLED' ? 'var(--text-3)' : 'var(--text)' }}>
              {won(p.amount)}
            </span>
            <span className="font-semibold text-2xs" style={{ color: p.status === 'CANCELLED' ? '#dc2626' : '#16a34a' }}>
              {p.status === 'CANCELLED' ? '취소결제' : p.status === 'COMPLETED' ? '완료' : '대기'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
