import { forwardRef } from 'react';
import { Select as RadixSelect } from 'radix-ui';
import { cn } from '../../lib/cn';

// 네이티브 <select> 를 대체하는 Radix Select 래퍼.
//
// 주의: Radix Select는 value="" (빈 문자열)을 허용하지 않는다.
// 기존에 <select value="">전체</option> 처럼 빈 문자열을 "전체" sentinel로 쓰던 곳은
// 'ALL' 같은 non-empty sentinel 값으로 바꾸고, 호출부(onValueChange 핸들러)에서
// 필요하면 다시 ''로 되돌려야 한다.

const TRIGGER_BASE = cn(
  'w-full px-[14px] py-[11px] border border-line-input rounded-[9px] text-base outline-none',
  'bg-inputbg text-fg shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)]',
  'inline-flex items-center justify-between gap-2',
  'data-[placeholder]:text-fg-3',
  'disabled:cursor-not-allowed disabled:opacity-55',
  'focus:border-brand focus:shadow-[0_0_0_3px_var(--purple-light),0_1px_4px_rgba(0,100,255,0.12),inset_0_1px_2px_rgba(0,100,255,0.06)]',
  '[transition:background-color_0.2s_ease,color_0.2s_ease,border-color_0.15s_ease,box-shadow_0.15s_ease]'
);

// 기존 select 화살표(index.css의 data-uri svg)를 그대로 재현.
function CaretIcon() {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const SelectItem = forwardRef(function SelectItem({ className, children, ...props }, ref) {
  return (
    <RadixSelect.Item
      ref={ref}
      className={cn(
        'relative flex items-center px-3 py-2 text-base rounded-sm cursor-pointer select-none outline-none',
        'data-[highlighted]:bg-brand-light data-[highlighted]:text-brand-dark',
        'data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
        className
      )}
      {...props}
    >
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
    </RadixSelect.Item>
  );
});

export function SelectRoot(props) {
  return <RadixSelect.Root {...props} />;
}

// 옵션 그룹/커스텀 렌더가 필요한 곳에서 쓰는 저수준 조각들.
export const SelectTrigger = forwardRef(function SelectTrigger({ className, children, ...props }, ref) {
  return (
    <RadixSelect.Trigger ref={ref} className={cn(TRIGGER_BASE, className)} {...props}>
      {children}
      <RadixSelect.Icon className="ml-2 shrink-0 text-fg-3">
        <CaretIcon />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
});

export function SelectContent({ className, children, ...props }) {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        position="popper"
        sideOffset={4}
        className={cn(
          'z-[200] min-w-[var(--radix-select-trigger-width)] bg-card border border-line rounded-md',
          'shadow-[0_25px_80px_rgba(0,0,0,0.22),0_8px_32px_rgba(0,0,0,0.12)] overflow-hidden',
          'animate-[dropdownIn_0.14s_cubic-bezier(0.22,1,0.36,1)] origin-top',
          className
        )}
        {...props}
      >
        <RadixSelect.ScrollUpButton className="flex items-center justify-center h-6 bg-card text-fg-3">
          ▲
        </RadixSelect.ScrollUpButton>
        <RadixSelect.Viewport className="p-1">{children}</RadixSelect.Viewport>
        <RadixSelect.ScrollDownButton className="flex items-center justify-center h-6 bg-card text-fg-3">
          ▼
        </RadixSelect.ScrollDownButton>
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

// 편의 API: <Select value onValueChange options={[{value,label}]} placeholder disabled className />
export function Select({ value, onValueChange, options = [], placeholder, disabled, className, name, ...rootProps }) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled} name={name} {...rootProps}>
      <SelectTrigger className={className}>
        <RadixSelect.Value placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </RadixSelect.Root>
  );
}

export default Select;
