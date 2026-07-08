import { CircleHelp, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DISCORD_INVITE_URL, WECHAT_QR_SRC } from "../lib/community.js";

/**
 * Top-bar support entry: a help icon whose dropdown offers the two community
 * channels (Discord link, WeChat group QR) so a stuck user can reach a human
 * without leaving the app. Static content only — no server state, no unread
 * badges. Open/close behaviour mirrors UserMenu (click-outside + Escape).
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
          style={{ width: 240 }}
        >
          <div className="border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <div className="text-subtitle font-medium" style={{ color: "var(--fg)" }}>
              Need help?
            </div>
            <div className="text-label" style={{ color: "var(--fg-3)" }}>
              Reach the team on either channel.
            </div>
          </div>
          <div className="py-1">
            <a
              role="menuitem"
              href={DISCORD_INVITE_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-body hover:bg-accent transition-colors"
              style={{ color: "var(--fg)" }}
            >
              <ExternalLink className="h-3.5 w-3.5" style={{ color: "var(--fg-3)" }} />
              <span>Join our Discord</span>
            </a>
          </div>
          <div
            className="flex flex-col items-center border-t px-4 py-3"
            style={{ borderColor: "var(--border)", gap: "var(--sp-1_5)" }}
          >
            <img
              src={WECHAT_QR_SRC}
              width={128}
              height={128}
              alt="WeChat group QR code"
              style={{
                borderRadius: 6,
                border: "var(--hairline) solid var(--border)",
              }}
            />
            <span className="text-caption" style={{ color: "var(--fg-4)" }}>
              Scan to join the WeChat group
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
