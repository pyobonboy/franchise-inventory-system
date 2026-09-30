import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

// 기존 index.css의 button / .primary / .secondary / .danger / .ghost / .small 규칙을
// 그대로 옮긴 것. 픽셀 값은 절대 임의로 조정하지 말 것.
const BASE = cn(
  'cursor-pointer border-none rounded-md px-4 py-2 text-base font-semibold tracking-[-0.1px]',
  'whitespace-nowrap inline-flex items-center gap-2',
  'disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none',
  'active:scale-[0.97]',
  "[transition:background-color_0.18s_cubic-bezier(0.4,0,0.2,1),color_0.18s,border-color_0.18s,transform_0.14s_cubic-bezier(0.34,1.56,0.64,1),box-shadow_0.15s]",
  'focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 focus-visible:shadow-[0_0_0_4px_rgba(0,100,255,0.15)]'
);

const VARIANTS = {
  primary:
    'bg-brand text-white shadow-[0_2px_8px_rgba(0,100,255,0.25),inset_0_1px_0_rgba(255,255,255,0.15)] hover:bg-brand-dark hover:shadow-[0_6px_18px_rgba(0,100,255,0.4),inset_0_1px_0_rgba(255,255,255,0.2)]',
  secondary:
    'bg-card text-fg-2 border border-line shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_1px_2px_rgba(0,0,0,0.05)] hover:bg-muted hover:text-fg',
  danger:
    'bg-[#fee2e2] text-[#b91c1c] hover:bg-[#fecaca] dark:bg-[#450a0a] dark:text-[#fca5a5] dark:hover:bg-[#5c0f0f] focus-visible:outline-[var(--color-danger)]',
  ghost:
    'bg-transparent text-fg-3 hover:bg-muted hover:text-fg-2',
};

const SIZES = {
  md: '',
  sm: 'px-3 py-1 text-[16px] rounded-sm',
};

export const Button = forwardRef(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE, VARIANTS[variant] || VARIANTS.secondary, SIZES[size] || '', className)}
      {...props}
    />
  );
});

export default Button;
