/**
 * Animated number count-up. Adapted from React Bits (reactbits.dev), trimmed
 * to hippo's needs: framer-motion's `animate` driver only, TypeScript.
 *
 * Counts from `from` to `to` with an ease-out curve on mount. Uses `animate`
 * with an onUpdate that writes directly to the DOM — this is more reliable
 * across webview environments than useSpring + .on('change') subscription,
 * which can silently fail to fire in some embedded browsers.
 */
import { animate } from 'framer-motion';
import { useEffect, useRef } from 'react';

export default function CountUp({
  to,
  from = 0,
  duration = 1.4,
  className = '',
}: {
  to: number;
  from?: number;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const controls = animate(from, to, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: latest => {
        el.textContent = Intl.NumberFormat('en-US').format(Math.round(latest));
      },
    });
    return () => controls.stop();
  }, [from, to, duration]);

  return <span ref={ref} className={className}>{Intl.NumberFormat('en-US').format(from)}</span>;
}
