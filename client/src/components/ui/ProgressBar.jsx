import { cn } from '../../lib/cn';

// 기존 .progress-bar / .progress-bar .fill 규칙 그대로.
// color는 데이터에 따라 달라지는 동적 값이라 style로 유지 (마이그레이션 규칙 1).
export function ProgressBar({ pct = 0, color, className, fillClassName }) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <div
      className={cn(
        'h-2 bg-line rounded-full overflow-hidden mt-[6px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]',
        className
      )}
    >
      <div
        className={cn(
          'h-full rounded-full origin-left',
          '[transition:width_0.4s_cubic-bezier(0.4,0,0.2,1)]',
          '[background-image:linear-gradient(90deg,transparent_0%,rgba(255,255,255,0.2)_50%,transparent_100%)]',
          '[background-size:200%_100%] animate-[shimmer_2.4s_infinite]',
          fillClassName
        )}
        style={{ width: `${clamped}%`, backgroundColor: color }}
      />
    </div>
  );
}

export default ProgressBar;
