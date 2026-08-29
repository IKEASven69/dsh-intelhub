/**
 * Entrance animation. Replaces React Bits' ScrollReveal (which needs gsap)
 * with a lean framer-motion version — one dependency, one component.
 * Children fade + rise into place on mount. Uses `animate` (not whileInView)
 * because IntersectionObserver is unreliable in some webview environments.
 */
import { motion } from 'framer-motion';

export default function FadeIn({
  children,
  delay = 0,
  y = 14,
  className = '',
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
