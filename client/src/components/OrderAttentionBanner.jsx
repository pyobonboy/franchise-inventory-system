import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

// 본사가 발주 수량조정/품절처리/수정요청 등으로 발주서를 변경하면, 가맹점이 화면에 들어와도
// 알 방법이 없던 문제를 없애기 위해 다음 진입 시 바로 모달로 알려준다 (공지사항 NoticeBanner와 동일한 패턴)
export default function OrderAttentionBanner({ storeId }) {
  const [pending, setPending] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!storeId) return;
    api.getAttentionOrders().then(setPending).catch(() => {});
  }, [storeId]);

  if (pending.length === 0) return null;
  const current = pending[0];

  const ack = async () => {
    try { await api.ackOrder(current.id); } catch { /* 실패해도 다음 진입 시 다시 노출되므로 무시 */ }
    setPending(prev => prev.slice(1));
  };

  const goToOrder = async () => {
    await ack();
    navigate('/store');
  };

  return (
    <div className="fixed inset-0 bg-black/55 flex items-center justify-center z-[9999]">
      <div className="bg-card rounded-[18px] px-9 py-8 shadow-[0_20px_60px_rgba(0,0,0,0.3)] border border-line max-w-[440px] w-[90vw]">
        <div className="text-2xs font-bold tracking-[0.4px] uppercase text-caution mb-2">
          발주 변경 알림{pending.length > 1 ? ` (${pending.length}건)` : ''}
        </div>
        <div className="text-[18px] font-extrabold mb-3 text-fg">
          발주서 #{current.id}에 변경사항이 있습니다
        </div>
        <div className="text-[14px] text-fg-2 leading-[1.7] whitespace-pre-wrap mb-6">
          {current.attention_note}
        </div>
        <div className="flex gap-2">
          <button
            onClick={ack}
            className="flex-1 py-3 bg-transparent text-fg border border-line rounded-md text-sm font-bold cursor-pointer"
          >
            닫기
          </button>
          <button
            onClick={goToOrder}
            className="flex-1 py-3 bg-caution text-white border-none rounded-md text-sm font-bold cursor-pointer"
          >
            발주내역 보기
          </button>
        </div>
      </div>
    </div>
  );
}
