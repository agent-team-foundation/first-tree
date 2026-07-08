import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CommunityChannels } from "./community-channels.js";

/**
 * Top-bar support entry: a help icon whose dropdown offers the two community
 * channels (WeChat group / Discord) as equal cards, so a stuck user can reach
 * a human without leaving the app. Static content only — no server state, no
 * unread badges. Open/close behaviour mirrors UserMenu (click-outside +
 * Escape).
 */
export function SupportMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (open && e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", escHandler);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", escHandler);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative" data-testid="support-menu">
      <button
        type="button"
        aria-label="Help and community"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title="Help & community"
        className="inline-flex items-center justify-center transition-colors"
        style={{
          height: 30,
          width: 30,
          color: "var(--fg-3)",
          background: "transparent",
          border: "none",
          borderRadius: "var(--radius-input)",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--fg)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--fg-3)";
        }}
      >
        <CircleHelp size={16} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 rounded-[var(--radius-panel)] border bg-popover shadow-md"
          style={{ width: 312 }}
        >
          <div className="border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <div className="text-subtitle font-medium" style={{ color: "var(--fg)" }}>
              Need help?
            </div>
            <div className="text-label" style={{ color: "var(--fg-3)" }}>
              Reach the team on either channel.
            </div>
          </div>
          <div style={{ padding: "var(--sp-3)" }}>
            <CommunityChannels />
          </div>
        </div>
      )}
    </div>
  );
}
