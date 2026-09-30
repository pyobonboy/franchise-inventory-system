import { cn } from '../../lib/cn';

// 기존 .empty (::before 대시) 규칙 그대로.
export function EmptyState({ className, children, ...props }) {
  return (
    <div
      className={cn('text-center text-fg-3 px-10 py-16 text-[16px] font-medium tracking-[-0.1px]', className)}
      {...props}
    >
      <span className="block text-[28px] font-extralight text-fg-3 opacity-[0.15] mb-[14px] [text-shadow:0_1px_2px_rgba(0,0,0,0.05)]">
        —
      </span>
      {children}
    </div>
  );
}

// 기존 .loading-state (::before 스피너) 규칙 그대로.
// spin 키프레임은 legacy.css 최상단(0.8s linear infinite)을 그대로 참조한다.
export function LoadingState({ className, children, ...props }) {
  return (
    <div className={cn('text-center text-fg-3 px-10 py-16 text-[15px] font-medium', className)} {...props}>
      <span className="block w-7 h-7 mx-auto mb-[14px] rounded-full border-[2.5px] border-black/[0.07] border-t-brand animate-[spin_0.8s_linear_infinite] shadow-[0_0_10px_rgba(0,100,255,0.18)]" />
      {children}
    </div>
  );
}

export default EmptyState;
