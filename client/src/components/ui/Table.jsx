import { cn } from '../../lib/cn';

// 기존 table/th/td 규칙 그대로.
// tr:last-child td { border-bottom: none } 는 TR에서 [&:last-child>td] 로,
// tr:hover td { background: var(--bg-elevated) } 는 TR에 group, TD에 group-hover: 로 구현.
export function Table({ className, ...props }) {
  return <table className={cn('w-full border-collapse text-base', className)} {...props} />;
}

export function THead({ className, ...props }) {
  return <thead className={className} {...props} />;
}

export function TBody({ className, ...props }) {
  return <tbody className={className} {...props} />;
}

export function TR({ className, ...props }) {
  return <tr className={cn('group [&:last-child>td]:border-b-0', className)} {...props} />;
}

export function TH({ className, ...props }) {
  return (
    <th
      className={cn(
        'text-left px-4 py-[14px] bg-muted font-semibold text-fg-3',
        'border-t border-t-[rgba(0,100,255,0.07)] border-b border-b-line text-[18px] whitespace-nowrap',
        className
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }) {
  return (
    <td
      className={cn(
        "px-4 py-4 border-b border-line align-middle text-fg [font-feature-settings:'tnum']",
        '[transition:background-color_0.12s_ease,box-shadow_0.12s_ease]',
        'group-hover:bg-elevated group-hover:shadow-[inset_0_1px_0_rgba(0,0,0,0.03),inset_0_-1px_0_rgba(0,0,0,0.03)]',
        className
      )}
      {...props}
    />
  );
}

export default Table;
