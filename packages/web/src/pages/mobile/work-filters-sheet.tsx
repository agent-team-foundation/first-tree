import type { ChatEngagementView } from "@first-tree/shared";
import { Check, Eye, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";

export type MobileWorkFilters = {
  engagement: ChatEngagementView;
  watching: boolean;
};

export function MobileWorkFiltersSheet({
  value,
  onChange,
  onClose,
}: {
  value: MobileWorkFilters;
  onChange: (next: MobileWorkFilters) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!items || items.length === 0) return;
    const first = items.item(0);
    const last = items.item(items.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 flex items-end" style={{ zIndex: 70 }} data-mobile-work-filters-root>
      <button
        type="button"
        aria-label="Close Work filters"
        onClick={onClose}
        className="absolute inset-0 border-0"
        style={{ background: "var(--overlay-scrim)" }}
      />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Work filters"
        onKeyDown={onKeyDown}
        className="relative z-10 w-full border-t animate-in fade-in slide-in-from-bottom-4 duration-150"
        style={{
          borderColor: "var(--border)",
          borderRadius: "var(--radius-dialog) var(--radius-dialog) 0 0",
          background: "var(--bg-raised)",
          boxShadow: "var(--shadow-md)",
          padding: "var(--sp-3) var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom))",
        }}
      >
        <div className="flex items-center" style={{ marginBottom: "var(--sp-3)" }}>
          <div className="min-w-0 flex-1">
            <h2 className="text-mobile-title" style={{ color: "var(--fg)", margin: 0 }}>
              Filter Work
            </h2>
            <p className="text-mobile-caption" style={{ color: "var(--fg-3)", margin: "var(--sp-1) 0 0" }}>
              Changes apply immediately.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close Work filters"
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-input)] border"
            style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="text-mobile-caption" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-1)" }}>
            Status
          </legend>
          <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
            {(["active", "archived", "all"] as const).map((engagement) => {
              const selected = value.engagement === engagement;
              return (
                <button
                  key={engagement}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChange({ ...value, engagement })}
                  className="flex min-h-12 w-full items-center rounded-[var(--radius-input)] text-left transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ gap: "var(--sp-3)", padding: "var(--sp-2) var(--sp-3)", color: "var(--fg)" }}
                >
                  <span className="text-mobile-body min-w-0 flex-1">
                    {engagement === "active" ? "Active" : engagement === "archived" ? "Archived" : "All"}
                  </span>
                  {selected ? <Check aria-hidden className="h-4 w-4" /> : null}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div style={{ height: "var(--hairline)", background: "var(--border-faint)", margin: "var(--sp-2) 0" }} />

        <button
          type="button"
          aria-pressed={value.watching}
          onClick={() => onChange({ ...value, watching: !value.watching })}
          className="flex min-h-12 w-full items-center rounded-[var(--radius-input)] text-left transition-colors hover:bg-[var(--bg-hover)]"
          style={{ gap: "var(--sp-3)", padding: "var(--sp-2) var(--sp-3)", color: "var(--fg)" }}
        >
          <Eye aria-hidden className="h-4 w-4" style={{ color: "var(--fg-3)" }} />
          <span className="text-mobile-body min-w-0 flex-1">Watching only</span>
          {value.watching ? <Check aria-hidden className="h-4 w-4" /> : null}
        </button>
      </section>
    </div>
  );
}
