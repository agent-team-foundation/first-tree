import { useEffect, useRef } from "react";

/**
 * Tiny IntersectionObserver hook — sets `data-visible="true"` on the target
 * the first time it enters the viewport, which the `.m-reveal` CSS class
 * uses to fade + slide in. No motion library needed.
 */
export function useReveal<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.visible = "true";
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return ref;
}
