import { forwardRef } from 'react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { cn } from '../../lib/cn';

// 기존 코드는 네이티브 <input type="checkbox"> 를 브라우저 기본 모양으로 썼고
// (index.css에는 active 시 scale(0.88)만 정의돼 있었다), 전용 디자인 값이 없었으므로
// 나머지 프리미티브(버튼/뱃지)와 톤을 맞춘 브랜드 컬러 체크박스로 새로 디자인했다 (임의 결정).
export const Checkbox = forwardRef(function Checkbox({ className, checked, onCheckedChange, disabled, ...props }, ref) {
  return (
    <RadixCheckbox.Root
      ref={ref}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn(
        'w-[19px] h-[19px] shrink-0 rounded-[5px] border border-line-input bg-inputbg',
        'shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] flex items-center justify-center outline-none',
        'data-[state=checked]:bg-brand data-[state=checked]:border-brand',
        'focus-visible:outline-2 focus-visible:outline-brand focus-visible:outline-offset-2 focus-visible:shadow-[0_0_0_4px_rgba(0,100,255,0.15)]',
        'disabled:cursor-not-allowed disabled:opacity-55',
        'active:scale-[0.88] [transition:transform_0.1s_ease,background-color_0.15s_ease,border-color_0.15s_ease]',
        className
      )}
      {...props}
    >
      <RadixCheckbox.Indicator className="text-white">
        <svg width="12" height="10" viewBox="0 0 12 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M1 5l3.5 3.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
});

export default Checkbox;
