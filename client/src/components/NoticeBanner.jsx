import { useEffect, useState } from 'react';
import { api } from '../api';

// 본사가 올린 공지 중 아직 안 읽은 것이 있으면 모달로 띄운다 (카톡/전화로 전달하다 누락되는 문제를 없애려는 목적)
export default function NoticeBanner({ storeId }) {
  const [unread, setUnread] = useState([]);

  useEffect(() => {
    if (!storeId) return;
    api.getMyNotices(storeId).then(notices => {
      setUnread(notices.filter(n => !n.is_read));
    }).catch(() => {});
  }, [storeId]);

  if (unread.length === 0) return null;
  const current = unread[0];

  const confirm = async () => {
    try { await api.markNoticeRead(current.id); } catch { /* 네트워크 오류여도 다음 진입 시 다시 노출되므로 무시 */ }
    setUnread(prev => prev.slice(1));
  };

  return (
    <div className="fixed inset-0 bg-black/45 backdrop-blur-[8px] flex items-center justify-center z-[9999]">
      <div className="bg-card rounded-[20px] px-9 py-8 shadow-[0_24px_64px_rgba(0,0,0,0.2),0_4px_16px_rgba(0,0,0,0.1)] border border-line max-w-[440px] w-[90vw]">
        <div className="text-2xs font-bold tracking-[0.8px] uppercase text-brand mb-2.5 border-t-[3px] border-t-brand pt-3">
          공지사항{unread.length > 1 ? ` (${unread.length}건)` : ''}
        </div>
        <div className="text-[18px] font-extrabold mb-3 text-fg">{current.title}</div>
        <div className="text-[14px] text-fg-2 leading-[1.7] whitespace-pre-wrap mb-6">
          {current.content}
        </div>
        <button
          onClick={confirm}
          className="w-full py-3 bg-brand text-white border-none rounded-md text-sm font-bold cursor-pointer"
        >
          확인{unread.length > 1 ? ' (다음 공지 보기)' : ''}
        </button>
      </div>
    </div>
  );
}
