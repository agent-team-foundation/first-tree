import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";

/**
 * Hover-intent floating card primitive (no dependency). Generic interaction
 * shell — knows nothing about agents. `<AgentHovercard>` (and later @mention
 * chips) build their content on top.
 *
 * Behavior:
 *  - desktop: hover the trigger ~400ms (intent) to open; a ~150ms grace lets the
 *    pointer cross the gap into the card without closing.
 *  - click the trigger = open + PIN (won't dismiss on mouse-out).
 *  - close: mouse-out past grace (unpinned) / Esc / outside click / scroll /
 *    route change.
 *  - a11y: the trigger is a focusable control (aria-haspopup/expanded);
 *    Enter/Space opens and moves focus into the card; Esc closes + restores focus.
 *  - portal + viewport-aware placement with flip/clamp.
 *
 * Positioning is hand-rolled (matches the repo's dependency-light style). If it
 * ever can't keep the card in view, swap to @floating-ui — the API here is small.
 */

const OPEN_DELAY_MS = 400;
const CLOSE_GRACE_MS = 150;
const VIEWPORT_MARGIN = 8;

export type HoverCardPlacement = "left" | "right" | "bottom";

type Coords = { top: number; left: number };

export function HoverCard({
  children,
  content,
  placement = "bottom",
  contentClassName,
  contentStyle,
  triggerClassName,
  ariaLabel,
}: {
  /** The inline trigger (e.g. avatar + name cluster). */
  children: ReactNode;
  /** Floating card body; receives `close` to wire action buttons. */
  content: (api: { close: () => void }) => ReactNode;
  placement?: HoverCardPlacement;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  triggerClassName?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusOnOpen = useRef(false);
  const panelId = useId();
  const location = useLocation();

  const clearTimers = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = null;
    openTimer.current = null;
  }, []);

  const close = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, [clearTimers]);

  // Route change closes the card (it may unmount the trigger / point at a stale agent).
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.pathname is the close trigger; close is stable.
  useEffect(() => {
    close();
  }, [location.pathname]);

  // Position the card on open (and on resize), with flip + clamp to viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current;
      const card = cardRef.current;
      if (!t || !card) return;
      const tr = t.getBoundingClientRect();
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left: number;
      let top: number;
      if (placement === "left" || placement === "right") {
        // Vertically aligned to the trigger; horizontally beside it, flip if needed.
        const wantLeft = placement === "left";
        const leftPos = tr.left - cw - 6;
        const rightPos = tr.right + 6;
        const fitsLeft = leftPos >= VIEWPORT_MARGIN;
        const fitsRight = rightPos + cw <= vw - VIEWPORT_MARGIN;
        left = wantLeft ? (fitsLeft ? leftPos : rightPos) : fitsRight ? rightPos : leftPos;
        top = tr.top;
      } else {
        // bottom: below the trigger, flip above if it would overflow.
        left = tr.left;
        const belowTop = tr.bottom + 6;
        const aboveTop = tr.top - ch - 6;
        top = belowTop + ch <= vh - VIEWPORT_MARGIN || aboveTop < VIEWPORT_MARGIN ? belowTop : aboveTop;
      }
      // Clamp inside the viewport on both axes.
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - cw - VIEWPORT_MARGIN));
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - ch - VIEWPORT_MARGIN));
      setCoords({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, placement]);

  // Move focus into the card when opened via keyboard.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const card = cardRef.current;
    if (!card) return;
    const focusable = card.querySelector<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])');
    (focusable ?? card).focus();
  }, [open]);

  // Global close listeners while open: Esc, outside click/pointer, scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || cardRef.current?.contains(target)) return;
      close();
    };
    const onScroll = () => close();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    // Capture scroll on any scroller; ignore scrolls inside the card itself.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  useEffect(() => clearTimers, [clearTimers]);

  const scheduleOpen = () => {
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const scheduleClose = () => {
    if (pinned) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        className={triggerClassName}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") scheduleOpen();
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") scheduleClose();
        }}
        onClick={() => {
          clearTimers();
          setPinned(true);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            clearTimers();
            focusOnOpen.current = true;
            setPinned(true);
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open
        ? createPortal(
            <div
              ref={cardRef}
              id={panelId}
              role="dialog"
              aria-label={ariaLabel}
              tabIndex={-1}
              className={contentClassName}
              style={{
                position: "fixed",
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                zIndex: 60,
                // Hidden until positioned, so it never flashes at the origin.
                visibility: coords ? "visible" : "hidden",
                ...contentStyle,
              }}
              onPointerEnter={cancelClose}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") scheduleClose();
              }}
            >
              {content({ close })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
