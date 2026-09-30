import { Tooltip as RadixTooltip } from 'radix-ui';
import { cn } from '../../lib/cn';

// 기존 코드에는 title="..." 네이티브 툴팁만 있었고 전용 CSS는 없었으므로,
// 배지/드롭다운과 톤을 맞춘 어두운 필(pill) 스타일을 새로 정했다 (임의 결정).
export const TooltipProvider = RadixTooltip.Provider;

// <Tip label="문구" side="top"><button/></Tip>
// Provider 없이도 단독으로 동작하도록 각 Tip이 자체 Provider로 감싼다.
export function Tip({ label, children, side = 'top', className, delayDuration = 300 }) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className={cn(
              'z-[200] bg-[#1a1a2e] text-white text-xs font-medium px-[10px] py-[6px] rounded-sm',
              'shadow-[0_8px_24px_rgba(0,0,0,0.25)] animate-[fadeUpIn_0.15s_ease]',
              className
            )}
          >
            {label}
            <RadixTooltip.Arrow className="fill-[#1a1a2e]" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

export default Tip;
