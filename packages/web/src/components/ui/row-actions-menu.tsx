import { type LucideIcon, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.js";

export type RowAction = {
  key: string;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/**
 * Kebab menu for a table/list row. Click-outside + Escape close. The trigger
 * flips its dropdown direction up when the menu would clip below the viewport.
 *
 * Each call site supplies its own action list — keeps the permission logic
 * in the page and the menu purely presentational. Returns `null` when actions
 * is empty so the cell stays clean instead of dangling an icon that does nothing.
 *
 * `triggerClassName` is for cases where the trigger needs additional CSS
 * (e.g. hover-reveal in a conversation row); it's merged onto the default
 * trigger button via `cn()`.
 */
export function RowActionsMenu({
  actions,
  ariaLabel,
  triggerClassName,
  icon: Icon = MoreHorizontal,
}: {
  actions: RowAction[];
  ariaLabel: string;
  triggerClassName?: string;
  icon?: LucideIcon;
}) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"down" | "up">("down");
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const ITEM_HEIGHT_ESTIMATE = 32;
    const MENU_PADDING = 8;
    const rect = buttonRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const estimatedHeight = actions.length * ITEM_HEIGHT_ESTIMATE + MENU_PADDING;
    setDirection(spaceBelow >= estimatedHeight ? "down" : "up");
  }, [open, actions.length]);

  if (actions.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={cn("inline-flex items-center justify-center", triggerClassName)}
        style={{
          width: 28,
          height: 28,
          borderRadius: 4,
          background: "transparent",
          color: "var(--fg-3)",
          cursor: "pointer",
          border: 0,
        }}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 rounded-md border bg-popover shadow-md"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            minWidth: 180,
            borderColor: "var(--border)",
            ...(direction === "up" ? { bottom: "100%", marginBottom: 4 } : { top: "100%", marginTop: 4 }),
          }}
        >
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                action.onSelect();
              }}
              className="flex w-full items-center px-3 py-1.5 text-left text-body hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                color: action.destructive ? "var(--state-error)" : "var(--fg)",
                background: "transparent",
                border: 0,
                cursor: action.disabled ? "not-allowed" : "pointer",
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
