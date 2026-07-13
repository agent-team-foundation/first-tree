import { Check, MoreVertical, Share, SquarePlus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../../components/ui/button.js";
import type { InstallGuideMode } from "./use-install-guide.js";

const BENEFITS = [
  "Opens instantly — no hunting for the link or signing in again",
  "Full screen — no browser address bar in the way",
] as const;

/**
 * Bottom-sheet "add to home screen" guide. Presentational: the parent owns when
 * it shows and what dismissal means (auto vs. manual). Mirrors the mobile team
 * switcher sheet (docked, scrim, safe-area padding).
 */
export function InstallGuideSheet({
  mode,
  onInstall,
  onClose,
}: {
  mode: InstallGuideMode;
  /** Native one-tap install (Android). Ignored for the instructional modes. */
  onInstall: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Modal focus management: move focus into the sheet, trap Tab within it, and
  // restore focus to the trigger on close (the sheet is hand-rolled, so unlike
  // Radix Dialog it must do this itself). Matters most for the auto-pop, which
  // appears unprompted.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    node?.focus();

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const focusables = [
        ...node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      // Focus sitting on the dialog root (initial) or escaped outside the set:
      // pull it back to the first/last control so Tab never leaves the sheet.
      if (!active || !focusables.includes(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end" data-mobile-install-sheet-root>
      <button
        type="button"
        aria-label="Dismiss"
        className="mobile-scrim-in absolute inset-0 bg-overlay-scrim"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-install-sheet-title"
        data-mobile-install-sheet="true"
        tabIndex={-1}
        className="mobile-sheet-in relative z-10 w-full overflow-y-auto border-t shadow-[var(--shadow-md)] focus:outline-none"
        style={{
          maxHeight: "88dvh",
          borderColor: "var(--border)",
          borderRadius: "var(--radius-dialog) var(--radius-dialog) 0 0",
          background: "var(--bg-raised)",
          padding: "var(--sp-3) var(--sp-5) calc(var(--sp-5) + env(safe-area-inset-bottom))",
        }}
      >
        <div
          aria-hidden
          style={{
            width: "var(--sp-8)",
            height: "var(--sp-1)",
            margin: "0 auto var(--sp-4)",
            borderRadius: "var(--radius-full)",
            background: "var(--border-strong)",
          }}
        />
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute inline-flex items-center justify-center rounded-[var(--radius-input)] transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            top: "var(--sp-3)",
            right: "var(--sp-3)",
            height: "var(--sp-8)",
            width: "var(--sp-8)",
            color: "var(--fg-3)",
          }}
        >
          <X aria-hidden className="h-4 w-4" />
        </button>

        <img
          src="/icons/first-tree-pwa.svg"
          alt=""
          width={56}
          height={56}
          style={{ display: "block", borderRadius: "var(--radius-panel)", marginBottom: "var(--sp-3_5)" }}
        />

        <h2 id="mobile-install-sheet-title" className="text-mobile-title" style={{ color: "var(--fg)", margin: 0 }}>
          Add First Tree to your home screen
        </h2>
        <p className="text-mobile-body" style={{ color: "var(--fg-3)", margin: "var(--sp-1_5) 0 var(--sp-4)" }}>
          One tap straight to your agent team next time — full screen, no address bar, just like a real app.
        </p>

        <ul
          className="flex flex-col"
          style={{ gap: "var(--sp-2_5)", margin: `0 0 var(--sp-5)`, padding: 0, listStyle: "none" }}
        >
          {BENEFITS.map((benefit) => (
            <li
              key={benefit}
              className="flex items-center text-mobile-body"
              style={{ gap: "var(--sp-2_5)", color: "var(--fg-2)" }}
            >
              <span
                aria-hidden
                className="inline-flex shrink-0 items-center justify-center"
                style={{
                  width: "var(--sp-5)",
                  height: "var(--sp-5)",
                  borderRadius: "var(--radius-full)",
                  background: "var(--brand-bg)",
                  color: "var(--brand)",
                }}
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
              {benefit}
            </li>
          ))}
        </ul>

        {mode === "native" ? (
          <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
            <Button type="button" variant="cta" size="lg" className="w-full" onClick={onInstall}>
              Add to Home Screen
            </Button>
            <Button type="button" variant="ghost" className="w-full" style={{ color: "var(--fg-3)" }} onClick={onClose}>
              Maybe later
            </Button>
          </div>
        ) : (
          <>
            <ol
              className="flex flex-col"
              style={{
                gap: "var(--sp-1)",
                margin: `0 0 var(--sp-4)`,
                padding: "var(--sp-3_5) var(--sp-4)",
                listStyle: "none",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-panel)",
                background: "var(--bg)",
              }}
            >
              {(mode === "ios" ? IOS_STEPS : ANDROID_STEPS).map((step, index) => (
                <li
                  key={step.key}
                  className="flex items-center text-mobile-body"
                  style={{ gap: "var(--sp-2_5)", color: "var(--fg-2)", padding: "var(--sp-1) 0" }}
                >
                  <span
                    aria-hidden
                    className="mono inline-flex shrink-0 items-center justify-center text-mobile-caption"
                    style={{
                      width: "var(--sp-5)",
                      height: "var(--sp-5)",
                      borderRadius: "var(--radius-full)",
                      border: "var(--hairline) solid var(--border)",
                      background: "var(--bg-raised)",
                      color: "var(--fg-3)",
                    }}
                  >
                    {index + 1}
                  </span>
                  <span className="inline-flex items-center" style={{ gap: "var(--sp-1_5)" }}>
                    {step.before}
                    <step.icon aria-hidden className="h-4 w-4 shrink-0" style={{ color: "var(--fg)" }} />
                    {step.after}
                  </span>
                </li>
              ))}
            </ol>
            <Button type="button" variant="ghost" className="w-full" style={{ color: "var(--fg-3)" }} onClick={onClose}>
              Got it
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

const IOS_STEPS = [
  { key: "share", before: "Tap the", icon: Share, after: "Share button below" },
  { key: "add", before: 'Choose "Add to Home Screen"', icon: SquarePlus, after: "" },
] as const;

const ANDROID_STEPS = [
  { key: "menu", before: "Open the", icon: MoreVertical, after: "browser menu" },
  { key: "add", before: 'Tap "Install app"', icon: SquarePlus, after: "" },
] as const;
