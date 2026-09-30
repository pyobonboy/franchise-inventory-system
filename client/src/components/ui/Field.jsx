import { cn } from '../../lib/cn';

// 기존 .form-group (+ label) 규칙 그대로.
// 모바일 규칙(`@media (max-width:768px) { .form-group { min-width: 0 } }`)은 components 레이어라
// 프리미티브가 내보내는 utilities 레이어 클래스를 이길 수 없어서, 여기로 가져온다.
export function Field({ label, className, children, ...props }) {
  return (
    <div className={cn('flex flex-col gap-[6px] flex-1 min-w-[120px] mb-4 max-[768px]:min-w-0', className)} {...props}>
      {label && <label className="text-[17px] text-fg-2 font-medium">{label}</label>}
      {children}
    </div>
  );
}

// 기존 .form-row 규칙 그대로 (모바일에서 세로 정렬되는 규칙 포함 — 위와 같은 이유로 여기로 옮김).
export function FieldRow({ className, children, ...props }) {
  return (
    <div className={cn('flex gap-4 items-end flex-wrap mb-4 max-[768px]:flex-col', className)} {...props}>
      {children}
    </div>
  );
}

export default Field;
