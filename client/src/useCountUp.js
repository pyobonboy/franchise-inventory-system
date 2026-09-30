import { useEffect, useRef, useState } from 'react';

// 숫자가 갑자기 바뀌는 대신 짧게 카운트업되며 채워지는 효과 — 색감/폰트는 그대로, 모션만 더함
export function useCountUp(value, duration = 500) {
  const [display, setDisplay] = useState(value || 0);
  const fromRef = useRef(value || 0);
  const frameRef = useRef(null);

  useEffect(() => {
    const target = Number(value) || 0;
    const from = fromRef.current;
    if (from === target) { setDisplay(target); return; }
    const start = performance.now();
    cancelAnimationFrame(frameRef.current);
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (target - from) * eased);
      if (t < 1) frameRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [value, duration]);

  return display;
}
