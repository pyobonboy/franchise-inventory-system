import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

// 기존 input/select/textarea 공용 규칙 그대로 (포커스 링, readonly 상태 포함).
const FIELD_BASE = cn(
  'w-full px-[14px] py-[11px] border border-line-input rounded-[9px] text-base outline-none',
  'bg-inputbg text-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]',
  'placeholder:text-fg-3 placeholder:opacity-70',
  'read-only:bg-muted read-only:text-fg-3 read-only:cursor-default',
  'focus:border-brand focus:shadow-[0_0_0_3px_var(--purple-light),0_1px_4px_rgba(0,100,255,0.12),inset_0_1px_2px_rgba(0,100,255,0.06)]',
  '[transition:background-color_0.2s_ease,color_0.2s_ease,border-color_0.15s_ease,box-shadow_0.15s_ease]'
);

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(FIELD_BASE, className)} {...props} />;
});

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(FIELD_BASE, className)} {...props} />;
});

export default Input;
