import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useRef } from "react";

/** Keyboard nudge step (px) for ArrowLeft / ArrowRight on the focused handle. */
const KEY_STEP = 16;

/**
 * Left-edge drag handle for the right sidebar. Mirrors the proven pattern in
 * `doc-preview-drawer.tsx`: the rail sits on the right, so dragging the handle
 * LEFT widens it (`startWidth + (startX - clientX)`).
 *
 * Width changes stream live via `onWidthChange` during the drag; persistence
 * is deferred to `onCommit` (fired once on mouse-up / per keypress) so we don't
 * thrash localStorage on every pointer move. Double-click resets to default.
 *
 * Rendered only in the inline (non-overlay) rail — the narrow-viewport overlay
 * is a fixed `min(88vw, 20rem)` and not resizable.
 */
export function SidebarResizeHandle({
  width,
  min,
  max,
  onWidthChange,
  onCommit,
  onReset,
}: {
  width: number;
  min: number;
  max: number;
  /** Live width while dragging / nudging — caller updates state, no persist. */
  onWidthChange: (next: number) => void;
  /** Settle: persist the final width (mouse-up, each keypress). */
  onCommit: (next: number) => void;
  /** Double-click: reset to the default width (and persist). */
  onReset: () => void;
}) {
  // Track the latest width without re-binding the drag listeners each render.
  const widthRef = useRef(width);
  widthRef.current = width;

  const clamp = useCallback((w: number) => Math.min(Math.max(Math.round(w), min), max), [min, max]);

  const startResize = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widthRef.current;
      let latest = startWidth;
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";

      const onMouseMove = (moveEvent: MouseEvent) => {
        latest = clamp(startWidth + (startX - moveEvent.clientX));
        onWidthChange(latest);
      };
      const onMouseUp = () => {
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        onCommit(latest);
      };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [clamp, onWidthChange, onCommit],
  );

  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const next = clamp(widthRef.current + KEY_STEP);
        onWidthChange(next);
        onCommit(next);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = clamp(widthRef.current - KEY_STEP);
        onWidthChange(next);
        onCommit(next);
      }
    },
    [clamp, onWidthChange, onCommit],
  );

  return (
    <button
      aria-label="Resize chat details"
      className="group absolute top-0 left-0 z-10 h-full w-3 -translate-x-1/2 cursor-col-resize"
      onDoubleClick={onReset}
      onKeyDown={resizeWithKeyboard}
      onMouseDown={startResize}
      title="Drag to resize · double-click to reset"
      type="button"
    >
      <div className="mx-auto h-full w-px bg-border-faint opacity-60 transition-all group-hover:w-1 group-hover:bg-accent group-hover:opacity-100" />
    </button>
  );
}
