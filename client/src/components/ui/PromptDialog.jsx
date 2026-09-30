import { useEffect, useRef, useState } from 'react';
import { Dialog as RadixDialog } from 'radix-ui';
import { Button } from './Button';
import { Input, Textarea } from './Input';
import { Select } from './Select';

// src/components/ui/ConfirmDialog.jsx 의 명령형 패턴(모듈 레벨 emitter + Host 컴포넌트)을 그대로 따른
// 네이티브 prompt() 대체 다이얼로그.
// await promptDialog({ title, description, defaultValue='', placeholder, multiline=false,
//   inputType='text', options, confirmText='확인', cancelText='취소' }) => Promise<string | null>
//
// 반환 규약은 네이티브 prompt() 와 동일하게 맞춘다:
//   취소/ESC/바깥 클릭 => null
//   확인 => 입력한 문자열 (숫자 입력이어도 문자열. 빈 입력이면 '')
//   options 모드에서 확인 => 선택된 value 문자열
const listeners = new Set();

export function promptDialog({
  title,
  description,
  defaultValue = '',
  placeholder,
  multiline = false,
  inputType = 'text',
  options,
  confirmText = '확인',
  cancelText = '취소',
} = {}) {
  return new Promise((resolve) => {
    const request = {
      id: Date.now() + Math.random(),
      title,
      description,
      defaultValue,
      placeholder,
      multiline,
      inputType,
      options,
      confirmText,
      cancelText,
      resolve,
    };
    listeners.forEach((fn) => fn(request));
  });
}

function subscribePrompt(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// App 루트에 1회 마운트. 연속 호출돼도 큐에 쌓아서 하나씩 순서대로 보여준다.
export function PromptDialogHost() {
  const [queue, setQueue] = useState([]);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => subscribePrompt((request) => setQueue((prev) => [...prev, request])), []);

  const current = queue[0];

  // 새 요청이 앞으로 올 때마다 입력값을 defaultValue로 리셋
  useEffect(() => {
    if (current) setValue(current.defaultValue ?? '');
  }, [current]);

  const settle = (result) => {
    if (!current) return;
    current.resolve(result);
    setQueue((prev) => prev.slice(1));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    settle(value);
  };

  return (
    <RadixDialog.Root
      open={!!current}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      {current && (
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 bg-black/[0.42] backdrop-blur-[8px] z-[100] animate-[overlayIn_0.18s_ease]" />
          <RadixDialog.Content
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              // 입력 필드가 있으면(옵션 모드가 아니면) 거기로 autoFocus, 선택 텍스트까지 지정
              if (inputRef.current) {
                e.preventDefault();
                inputRef.current.focus();
                inputRef.current.select?.();
              }
            }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] bg-card rounded-[18px] p-7 w-[90vw] max-[768px]:p-[18px] max-[768px]:w-full max-w-[480px] max-h-[80vh] overflow-y-auto border border-line shadow-[0_25px_80px_rgba(0,0,0,0.22),0_8px_32px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.5)] animate-[modalIn_0.2s_cubic-bezier(0.34,1.2,0.64,1)] outline-none"
          >
            <RadixDialog.Title className="text-xl font-bold mb-5 text-fg">{current.title}</RadixDialog.Title>
            {current.description ? (
              <RadixDialog.Description className="text-base text-fg-2 leading-[1.5] mb-3">
                {current.description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">입력이 필요합니다</RadixDialog.Description>
            )}
            <form onSubmit={handleSubmit}>
              {current.options ? (
                <Select
                  value={value}
                  onValueChange={setValue}
                  options={current.options}
                  placeholder={current.placeholder}
                />
              ) : current.multiline ? (
                <Textarea
                  ref={inputRef}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={current.placeholder}
                  rows={4}
                />
              ) : (
                <Input
                  ref={inputRef}
                  type={current.inputType}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={current.placeholder}
                />
              )}
              <div className="flex justify-end gap-3 mt-5">
                <Button type="button" variant="secondary" onClick={() => settle(null)}>
                  {current.cancelText}
                </Button>
                <Button type="submit" variant="primary">
                  {current.confirmText}
                </Button>
              </div>
            </form>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      )}
    </RadixDialog.Root>
  );
}

export default PromptDialogHost;
