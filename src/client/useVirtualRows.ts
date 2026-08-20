import { useEffect, useState, type RefObject } from "react";

const OVERSCAN = 6;

/**
 * Windowed row range for a scrollable table container: returns [start, end)
 * into a `count`-length row list so only the visible slice (+ overscan)
 * renders. Top/bottom spacer rows at the call site keep the scrollbar
 * accurate. `active` must be false whenever the container is unmounted —
 * the scroll binding follows its mount state.
 */
export function useVirtualRows(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  count: number,
  rowHeight: number,
): { start: number; end: number } {
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) {
      return;
    }
    const update = () => setScroll({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref, active]);
  const start = Math.max(0, Math.floor(scroll.top / rowHeight) - OVERSCAN);
  const end = Math.min(count, Math.ceil((scroll.top + scroll.height) / rowHeight) + OVERSCAN);
  return { start, end };
}
