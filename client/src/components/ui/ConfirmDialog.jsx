import { useEffect, useState } from 'react';
import { AlertDialog } from 'radix-ui';
import { Button } from './Button';

// src/toast.js 의 pub/sub 패턴을 그대로 참고한 명령형 확인 다이얼로그.
// await confirmDialog({ title, description, confirmText='확인', cancelText='취소', tone='danger' }) => boolean
const listeners = new Set();

export function confirmDialog({ title, description, confirmText = '확인', cancelText = '취소', tone = 'danger' } = {}) {
  return new Promise((resolve) => {
    const request = {
      id: Date.now() + Math.random(),
      title,
      description,
      confirmText,
      cancelText,
      tone,
      resolve,
    };
    listeners.forEach((fn) => fn(request));
  });
}

function subscribeConfirm(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// App 루트에 1회 마운트. 여러 번 연속으로 confirmDialog()가 호출돼도
// 큐에 쌓아서 하나씩 순서대로 보여준다.
export function ConfirmDialogHost() {
  const [queue, setQueue] = useState([]);

  useEffect(() => subscribeConfirm((request) => setQueue((prev) => [...prev, request])), []);

  const current = queue[0];

  const settle = (result) => {
    if (!current) return;
    current.resolve(result);
    setQueue((prev) => prev.slice(1));
  };

  return (
    <AlertDialog.Root
      open={!!current}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
    >
      {current && (
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/[0.42] backdrop-blur-[8px] z-[100] animate-[overlayIn_0.18s_ease]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] bg-card rounded-[18px] p-7 w-[90vw] max-[768px]:p-[18px] max-[768px]:w-full max-w-[480px] max-h-[80vh] overflow-y-auto border border-line shadow-[0_25px_80px_rgba(0,0,0,0.22),0_8px_32px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.5)] animate-[modalIn_0.2s_cubic-bezier(0.34,1.2,0.64,1)] outline-none">
            <AlertDialog.Title className="text-xl font-bold mb-5 text-fg">{current.title}</AlertDialog.Title>
            {current.description ? (
              <AlertDialog.Description className="text-base text-fg-2 leading-[1.5]">
                {current.description}
              </AlertDialog.Description>
            ) : (
              <AlertDialog.Description className="sr-only">확인이 필요합니다</AlertDialog.Description>
            )}
            <div className="flex justify-end gap-3 mt-5">
              <AlertDialog.Cancel asChild>
                <Button variant="secondary" onClick={() => settle(false)}>
                  {current.cancelText}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant={current.tone === 'danger' ? 'danger' : 'primary'} onClick={() => settle(true)}>
                  {current.confirmText}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      )}
    </AlertDialog.Root>
  );
}

export default ConfirmDialogHost;
