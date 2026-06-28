import {
  cloneElement,
  type ReactElement,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

/**
 * Lightweight text tooltip (no dependency). A faster, styled replacement for
 * the native `title` attribute: the browser's `title` delay is fixed by the
 * OS (~0.5–1.5s) and not tunable, so a control that wants a snappier hover
 * label has to render its own. Matches the repo's dependency-light style —
 * same hand-rolled portal + viewport-clamp approach as `HoverCard`, trimmed
 * to a single non-interactive label.
 *
 * Behavior:
 *  - hover the trigger for `delayMs` (default 120ms) to show; leaving hides at once.
 *  - keyboard focus shows immediately (no delay) and blur hides — so the label
 *    is reachable without a pointer.
 *  - Esc / scroll / route-level unmount hides.
 *  - portal + viewport-aware placement (prefers `top`, flips to `bottom`, clamps x).
 *
 * The trigger is cloned (no wrapper element), so it stays a direct flex/grid
 * child — overlapping avatar stacks and fixed-size icon buttons keep their
 * layout. The trigger keeps its own `aria-label` as the accessible name; this
 * tooltip is a visual affordance only, so it is `aria-hidden` to avoid the
 * screen reader announcing the same words twice.
 */

const OPEN_DELAY_MS = 120;
const VIEWPORT_MARGIN = 8;
const GAP = 6;

type Coords = { top: number; left: number };

// Merge an incoming ref (callback or object) with our own internal ref so a
// cloned trigger that already carries a ref keeps working.
function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref && typeof ref === "object") (ref as { current: T | null }).current = value;
}

export function Tooltip({
  label,
  children,
  placement = "top",
  delayMs = OPEN_DELAY_MS,
}: {
  /** Tooltip text. When empty, the trigger renders untouched (no tooltip). */
  label: string | undefined | null;
  /** A single focusable trigger element (e.g. a `<button>` / `<a>`). */
  children: ReactElement;
  placement?: "top" | "bottom";
  delayMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A pointer press focuses the trigger; this flag suppresses the focus-open
  // that immediately follows so a mouse click doesn't flash the tooltip. The
  // hover (pointerenter) path still shows it; keyboard focus is unaffected.
  const suppressFocusOpen = useRef(false);
  const tipId = useId();

  const clearTimer = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);
  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);
  const scheduleOpen = useCallback(() => {
    clearTimer();
    openTimer.current = setTimeout(() => setOpen(true), delayMs);
  }, [clearTimer, delayMs]);
  const openNow = useCallback(() => {
    clearTimer();
    setOpen(true);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  // Position on open + on resize, preferring `placement` and flipping if it
  // would overflow, then clamping inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current;
      const tip = tipRef.current;
      if (!t || !tip) return;
      const tr = t.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const aboveTop = tr.top - th - GAP;
      const belowTop = tr.bottom + GAP;
      let top =
        placement === "top"
          ? aboveTop >= VIEWPORT_MARGIN || belowTop + th > vh - VIEWPORT_MARGIN
            ? aboveTop
            : belowTop
          : belowTop + th <= vh - VIEWPORT_MARGIN || aboveTop < VIEWPORT_MARGIN
            ? belowTop
            : aboveTop;
      let left = tr.left + tr.width / 2 - tw / 2;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - tw - VIEWPORT_MARGIN));
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - th - VIEWPORT_MARGIN));
      setCoords({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, placement]);

  // Esc and any scroll hide the tooltip while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScroll = () => close();
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  if (!label) return children;

  // React 19 passes `ref` as a regular prop, so read it from `children.props`
  // (accessing `children.ref` is deprecated and logs a dev warning).
  const childProps = children.props as {
    ref?: Ref<HTMLElement>;
    onPointerDown?: (e: React.PointerEvent) => void;
    onPointerEnter?: (e: React.PointerEvent) => void;
    onPointerLeave?: (e: React.PointerEvent) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
  };
  const childRef = childProps.ref;

  const trigger = cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      setRef(childRef, node);
    },
    onPointerDown: (e: React.PointerEvent) => {
      childProps.onPointerDown?.(e);
      suppressFocusOpen.current = true;
    },
    onPointerEnter: (e: React.PointerEvent) => {
      childProps.onPointerEnter?.(e);
      if (e.pointerType === "mouse") scheduleOpen();
    },
    onPointerLeave: (e: React.PointerEvent) => {
      childProps.onPointerLeave?.(e);
      close();
    },
    onFocus: (e: React.FocusEvent) => {
      childProps.onFocus?.(e);
      // Open immediately only for keyboard focus. A focus that follows a
      // pointer press is a click — the hover path covers that case, so opening
      // here too would just flash the tooltip on every click.
      if (suppressFocusOpen.current) {
        suppressFocusOpen.current = false;
        return;
      }
      openNow();
    },
    onBlur: (e: React.FocusEvent) => {
      childProps.onBlur?.(e);
      suppressFocusOpen.current = false;
      close();
    },
  } as Partial<typeof children.props>);

  return (
    <>
      {trigger}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={tipId}
              role="tooltip"
              aria-hidden="true"
              className="mono text-caption"
              style={{
                position: "fixed",
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                zIndex: 70,
                pointerEvents: "none",
                visibility: coords ? "visible" : "hidden",
                maxWidth: 280,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                color: "var(--fg)",
                background: "var(--bg-raised)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-chip)",
                boxShadow: "var(--shadow-sm)",
                padding: "var(--sp-0_5) var(--sp-1_5)",
              }}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
