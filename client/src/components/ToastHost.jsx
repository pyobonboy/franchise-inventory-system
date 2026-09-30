import { useEffect, useRef, useState } from 'react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { subscribeToast } from '../toast';
import { cn } from '../lib/cn';

const CONFIG = {
  info:    { color: 'var(--purple)', bg: 'var(--purple-light)', icon: 'ℹ' },
  success: { color: '#16a34a',       bg: '#dcfce7',             icon: '✓' },
  error:   { color: '#dc2626',       bg: '#fee2e2',             icon: '✕' },
  warning: { color: '#d97706',       bg: '#fef3c7',             icon: '⚠' },
};

// 에러/경고는 읽을 시간이 더 필요하므로 조금 더 길게 띄움
const DURATION = { info: 3200, success: 3200, error: 5000, warning: 4200 };

// 타입/토스트별 자동 닫힘 타이머는 Radix의 내장 duration을 쓰지 않고(=Infinity로 꺼둠)
// 기존과 동일하게 직접 관리한다. 이유: Radix의 기본 hover-pause는 뷰포트 전체 단위로
// 동작해서(하나에 마우스를 올리면 다른 토스트까지 같이 멈춤) 기존 "토스트별 개별 pause"
// 동작과 달라지므로, 기존 elapsedRef/setTimeout 로직을 그대로 유지해 pause를 토스트
// 단위로 재현했다. open={!t.exiting} 로 Radix의 data-state를 바꿔 in/out 애니메이션만
// Radix Toast.Root에 맡긴다.
function ToastItem({ t, onDismiss }) {
  const c = CONFIG[t.type] || CONFIG.info;
  const duration = DURATION[t.type] || 3200;
  const [paused, setPaused] = useState(false);
  const elapsedRef = useRef(0);
  const startRef = useRef(null);

  useEffect(() => {
    if (t.exiting || paused) return;
    startRef.current = Date.now();
    const remaining = duration - elapsedRef.current;
    const timer = setTimeout(() => onDismiss(t.id), remaining);
    return () => {
      clearTimeout(timer);
      elapsedRef.current += Date.now() - startRef.current;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, t.exiting]);

  return (
    <ToastPrimitive.Root
      open={!t.exiting}
      duration={Infinity}
      onOpenChange={(open) => {
        if (!open) onDismiss(t.id);
      }}
      onClick={() => onDismiss(t.id)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cn(
        'relative overflow-hidden rounded-xl px-4 py-3.5 flex items-start gap-3 cursor-pointer select-none',
        'border border-line text-fg',
        'shadow-[0_12px_40px_rgba(0,0,0,0.16),0_2px_8px_rgba(0,0,0,0.08)]',
        'data-[state=open]:animate-[toastIn_0.22s_ease]',
        'data-[state=closed]:animate-[toastOut_0.22s_ease_forwards]',
        'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]',
        'data-[swipe=cancel]:translate-x-0',
        'data-[swipe=end]:animate-[toastOut_0.22s_ease_forwards]'
      )}
      style={{
        background: 'linear-gradient(135deg, var(--bg-card) 0%, rgba(0,100,255,0.02) 100%)',
        borderLeft: `3px solid ${c.color}`,
      }}
    >
      {/* 아이콘 */}
      <div
        className="w-7 h-7 rounded-lg shrink-0 flex items-center justify-center text-sm font-bold shadow-[inset_0_1px_2px_rgba(255,255,255,0.4),0_1px_3px_rgba(0,0,0,0.06)]"
        style={{ background: c.bg, color: c.color }}
      >
        {c.icon}
      </div>
      {/* 메시지 */}
      <ToastPrimitive.Title className="flex-1 pt-[3px] text-sm leading-[1.5] font-medium">
        {t.message}
      </ToastPrimitive.Title>
      {/* 닫기 */}
      <div className="shrink-0 text-fg-3 text-base leading-none pt-[3px] opacity-60">✕</div>
      {/* 자동 닫힘 진행바 — 마우스를 올리면 멈춤 */}
      {!t.exiting && (
        <div className="absolute left-0 right-0 bottom-0 h-[2.5px] bg-black/[0.05]">
          <div
            className="h-full origin-left"
            style={{
              background: c.color,
              animation: `toastProgress ${duration}ms linear forwards`,
              animationPlayState: paused ? 'paused' : 'running',
            }}
          />
        </div>
      )}
    </ToastPrimitive.Root>
  );
}

export default function ToastHost() {
  const [items, setItems] = useState([]);

  useEffect(
    () =>
      subscribeToast((t) => {
        setItems((prev) => [...prev, { ...t, exiting: false }]);
      }),
    []
  );

  const dismiss = (id) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, exiting: true } : i)));
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 250);
  };

  return (
    <ToastPrimitive.Provider swipeDirection="right" duration={Infinity}>
      {items.map((t) => (
        <ToastItem key={t.id} t={t} onDismiss={dismiss} />
      ))}
      <ToastPrimitive.Viewport
        className="fixed bottom-6 right-6 z-[10000] flex flex-col gap-2.5 max-w-[380px] min-w-[280px] list-none m-0 p-0 outline-none"
      />
      {/* toastIn/toastOut/toastProgress 는 이 컴포넌트 전용 애니메이션이라
          legacy.css가 아니라 여기서 직접 정의한다 (기존에도 이 파일 안에 있었음). */}
      <style>{`
        @keyframes toastIn {
          from { transform: translateX(20px); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        @keyframes toastOut {
          from { transform: translateX(0);    opacity: 1; max-height: 80px; margin-bottom: 0; }
          to   { transform: translateX(20px); opacity: 0; max-height: 0;    margin-bottom: -10px; }
        }
        @keyframes toastProgress {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
      `}</style>
    </ToastPrimitive.Provider>
  );
}
