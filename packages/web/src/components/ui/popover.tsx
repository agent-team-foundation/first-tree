import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils.js";

type PopoverState = { open: boolean; toggle: () => void; close: () => void };

type PopoverProps = {
  trigger: (state: PopoverState) => ReactNode;
  children: (state: { close: () => void }) => ReactNode;
  /** Where the popover anchors relative to the trigger. `end` right-aligns. */
  align?: "start" | "end";
  /** Pixel gap between trigger and panel. Default 4. */
  offset?: number;
  /** Optional className applied to the popover panel. */
  panelClassName?: string;
  /** Optional inline style applied to the popover panel. */
  panelStyle?: React.CSSProperties;
  /** Optional className applied to the trigger wrapper. */
  className?: string;
};

/**
 * Generic anchored popover primitive. Renders via React portal so an
 * `overflow: hidden` ancestor (the workspace rail) can't clip the panel.
 * Click-outside (across the trigger / panel pair) and Escape close it;
 * the panel is `position: fixed` and reanchors on each open.
 *
 * Trigger and content are render-props so callers can fully style the
 * trigger button (active state, count badges, focus rings) while still
 * sharing the open/close mechanics. Content receives `close` for any
 * "Done" / "Apply" buttons that should dismiss the popover.
 */
export function Popover({
  trigger,
  children,
  align = "start",
  offset = 4,
  panelClassName,
  panelStyle,
  className,
}: PopoverProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // Position is recomputed every time the popover opens so a layout
  // shift (sidebar resize, keyboard appearing on mobile, etc) between
  // mounts doesn't anchor the next open onto stale coordinates.
  const [position, setPosition] = useState<{ top: number; left: number | undefined; right: number | undefined }>({
    top: 0,
    left: undefined,
    right: undefined,
  });

  const close = (): void => setOpen(false);
  const toggle = (): void => setOpen((v) => !v);

  // Outside click + Escape. Bound only while open so a closed popover
  // doesn't pay the global listener cost.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Anchor the panel under the trigger. `useLayoutEffect` so the panel
  // never flashes at (0,0) before snapping into place on first paint.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPosition({
      top: rect.bottom + offset,
      left: align === "start" ? rect.left : undefined,
      right: align === "end" ? window.innerWidth - rect.right : undefined,
    });
  }, [open, align, offset]);

  return (
    <>
      <span ref={triggerRef} className={cn("inline-flex", className)}>
        {trigger({ open, toggle, close })}
      </span>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            className={cn("z-50", panelClassName)}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              right: position.right,
              background: "var(--bg-raised)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-panel)",
              boxShadow: "var(--shadow-md)",
              ...panelStyle,
            }}
          >
            {children({ close })}
          </div>,
          document.body,
        )}
    </>
  );
}
