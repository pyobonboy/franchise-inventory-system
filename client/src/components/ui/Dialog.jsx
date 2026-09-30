import { Dialog as RadixDialog } from 'radix-ui';
import { cn } from '../../lib/cn';

// 수제 .modal-overlay / .modal 다이얼로그를 대체하는 Radix Dialog 래퍼.
// <Modal open onOpenChange title footer maxWidth={480}>{body}</Modal>
export function Modal({ open, onOpenChange, title, footer, maxWidth = 480, children, className }) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-black/[0.42] backdrop-blur-[8px] z-[100] animate-[overlayIn_0.18s_ease]" />
        <RadixDialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100]',
            // 모바일 규칙(`@media (max-width:768px) { .modal { padding:18px; width:100% } }`)은
            // components 레이어라 utilities 레이어인 p-7/w-[90vw]를 이길 수 없어서 여기로 가져온다.
            'bg-card rounded-[18px] p-7 w-[90vw] max-[768px]:p-[18px] max-[768px]:w-full',
            'max-h-[80vh] overflow-y-auto border border-line',
            'shadow-[0_25px_80px_rgba(0,0,0,0.22),0_8px_32px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.5)]',
            'animate-[modalIn_0.2s_cubic-bezier(0.34,1.2,0.64,1)] outline-none',
            className
          )}
          style={{ maxWidth }}
        >
          {title ? (
            <RadixDialog.Title className="text-xl font-bold mb-5 text-fg">{title}</RadixDialog.Title>
          ) : (
            <RadixDialog.Title className="sr-only">Dialog</RadixDialog.Title>
          )}
          {children}
          {footer && (
            <div className="flex justify-end gap-3 mt-5 relative shadow-[0_-8px_12px_-8px_rgba(15,23,42,0.06)]">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export default Modal;
