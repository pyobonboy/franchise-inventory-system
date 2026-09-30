import { cn } from '../../lib/cn';

// 기존 .card 규칙 그대로 (border-top 강조선 포함, 다크에서 색상만 교체).
// box-shadow는 legacy.css 403줄이 아니라 뒤쪽 1265줄 정의가 실효값이다 (같은 레이어에서 뒤가 이김).
// 모바일(<=768px) 규칙은 legacy.css의 `@media (max-width:768px) { .card { ... } }` 에 있었는데,
// 그 규칙은 components 레이어라 Card가 내보내는 utilities 레이어 클래스를 이길 수 없다.
// 그래서 반응형 동작을 프리미티브 안으로 가져온다 — 레거시 클래스 유무와 무관하게 동작하게.
export function Card({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'bg-card rounded-lg p-6 mb-6 border border-line',
        'border-t-2 border-t-[rgba(0,100,255,0.14)] dark:border-t-[rgba(100,160,255,0.18)]',
        'shadow-[var(--shadow),inset_0_1px_0_rgba(255,255,255,0.5)]',
        'dark:shadow-[var(--shadow),inset_0_1px_0_rgba(255,255,255,0.04)]',
        'hover:border-line-input',
        'max-[768px]:p-[14px] max-[768px]:overflow-x-auto max-[768px]:[&_table]:min-w-[480px]',
        '[transition:background-color_0.2s_ease,color_0.2s_ease,border-color_0.18s_ease]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// 기존 .elevated-card 규칙 그대로.
export function ElevatedCard({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'bg-elevated rounded-md border border-line hover:border-line-input',
        '[transition:background-color_0.2s_ease,color_0.2s_ease,border-color_0.18s_ease,box-shadow_0.18s_ease]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export default Card;
