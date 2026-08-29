/**
 * Card with a cursor-following spotlight glow on hover. Adapted from React
 * Bits (reactbits.dev) — pure CSS + a mouse-move handler, no animation deps.
 * Spotlight color defaults to the hippo primary violet.
 */
import { useRef } from 'react';

export default function SpotlightCard({
  children,
  className = '',
  spotlightColor = 'rgba(167, 139, 250, 0.18)',
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  spotlightColor?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  const handleMouseMove = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    el.style.setProperty('--my', `${e.clientY - rect.top}px`);
    el.style.setProperty('--spot', spotlightColor);
  };
  return (
    <div ref={ref} onMouseMove={handleMouseMove} className={`spotlight-card ${className}`} {...rest}>
      {children}
    </div>
  );
}
