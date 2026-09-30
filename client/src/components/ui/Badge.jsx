import { cn } from '../../lib/cn';

// 기존 .badge / .badge.red|green|yellow / .badge.subtle 규칙 그대로.
// ::before 로 그리던 7px 원형 점은 실제 <span> 엘리먼트로 렌더링한다.
const TONE = {
  red: {
    solid: 'bg-[#fee2e2] text-[#b91c1c] dark:bg-[#450a0a] dark:text-[#fca5a5]',
    dot: 'bg-[#ef4444] dark:bg-[#fca5a5]',
  },
  green: {
    solid: 'bg-[#dcfce7] text-[#15803d] dark:bg-[#052e16] dark:text-[#86efac]',
    dot: 'bg-[#22c55e] dark:bg-[#86efac]',
  },
  yellow: {
    solid: 'bg-[#fef3c7] text-[#92400e] dark:bg-[#422006] dark:text-[#fcd34d]',
    dot: 'bg-[#f59e0b] dark:bg-[#fcd34d]',
  },
  // 원본 legacy.css의 색 모디파이어 없는 .badge / .badge::before 그대로.
  // 배경/글자색을 지정하지 않아 상속되고(투명 배경 + 부모 글자색), 점도 배경 없이 흰 링만 남는다.
  neutral: {
    solid: '',
    dot: '',
  },
};

export function Badge({ tone = 'red', subtle = false, className, children, ...props }) {
  const t = TONE[tone] || TONE.red;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[5px] rounded-sm text-xs font-semibold tracking-[0.3px]',
        '[transition:background-color_0.2s_ease,color_0.2s_ease,filter_0.12s_ease]',
        subtle
          ? 'bg-transparent px-[2px] py-1 text-fg-2'
          : cn(
              'px-[10px] py-[3px]',
              'shadow-[0_2px_6px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_2px_rgba(0,0,0,0.06)]',
              t.solid
            ),
        className
      )}
      {...props}
    >
      <span className={cn('w-[7px] h-[7px] rounded-full shrink-0 shadow-[0_0_0_2px_rgba(255,255,255,0.5)]', t.dot)} />
      {children}
    </span>
  );
}

export default Badge;
