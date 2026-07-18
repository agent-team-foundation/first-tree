import { type KeyboardEvent, type MouseEvent, type PointerEvent, useCallback, useEffect, useRef } from "react";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

type LongPressHandlers = {
  "aria-description": string;
  "aria-haspopup": "dialog";
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  style: { touchAction: "pan-y"; userSelect: "none"; WebkitTouchCallout: "none" };
};

/**
 * Long-press is deliberately an enhancement to the card's normal click:
 * scrolling or moving cancels it, while right-click and keyboard context-menu
 * keys expose the same dialog without adding a visible overflow control.
 */
export function useLongPress(onLongPress: (trigger: HTMLElement) => void, onClick: () => void): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const lastLongPressAtRef = useRef(0);
  const suppressClickRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", cancel, true);
    return () => {
      window.removeEventListener("scroll", cancel, true);
      cancel();
    };
  }, [cancel]);

  return {
    "aria-description": "Long press for chat actions",
    "aria-haspopup": "dialog",
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      cancel();
      triggerRef.current = event.currentTarget;
      originRef.current = { x: event.clientX, y: event.clientY };
      suppressClickRef.current = false;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastLongPressAtRef.current = Date.now();
        suppressClickRef.current = true;
        onLongPress(triggerRef.current ?? event.currentTarget);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const origin = originRef.current;
      if (!origin) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClick: (event) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick();
    },
    onContextMenu: (event) => {
      event.preventDefault();
      cancel();
      // Mobile browsers may emit `contextmenu` immediately after our own
      // timer fires. Ignore only that synthetic companion event; a later
      // mouse right-click remains a fresh way to open the sheet.
      if (Date.now() - lastLongPressAtRef.current > 750) onLongPress(event.currentTarget);
    },
    onKeyDown: (event) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      event.preventDefault();
      cancel();
      onLongPress(event.currentTarget);
    },
    style: { touchAction: "pan-y", userSelect: "none", WebkitTouchCallout: "none" },
  };
}
