import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import { cn } from '../../lib/cn';

// <DropdownMenu trigger={node} align="end" items={[{label,onSelect,tone,disabled} | 'separator']} />
// 등장 애니메이션은 기존 legacy.css의 dropdownIn 키프레임(⋮ 메뉴용)을 그대로 재사용.
export function DropdownMenu({ trigger, align = 'end', items = [], className, contentProps }) {
  return (
    <RadixDropdownMenu.Root>
      <RadixDropdownMenu.Trigger asChild>{trigger}</RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          align={align}
          sideOffset={6}
          className={cn(
            'z-[200] min-w-[160px] bg-card border border-line rounded-md p-1',
            'shadow-[0_25px_80px_rgba(0,0,0,0.22),0_8px_32px_rgba(0,0,0,0.12)] outline-none',
            'animate-[dropdownIn_0.14s_cubic-bezier(0.22,1,0.36,1)] origin-top-right',
            className
          )}
          {...contentProps}
        >
          {items.map((item, i) =>
            item === 'separator' ? (
              <RadixDropdownMenu.Separator key={`sep-${i}`} className="h-px bg-line my-1 -mx-1" />
            ) : (
              <RadixDropdownMenu.Item
                key={item.label}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 text-base rounded-sm cursor-pointer select-none outline-none',
                  'data-[highlighted]:bg-brand-light data-[highlighted]:text-brand-dark',
                  'data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
                  item.tone === 'danger' && 'text-[#b91c1c] dark:text-[#fca5a5]'
                )}
              >
                {item.label}
              </RadixDropdownMenu.Item>
            )
          )}
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}

export default DropdownMenu;
