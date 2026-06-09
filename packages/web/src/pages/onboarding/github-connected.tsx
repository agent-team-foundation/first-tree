import { Check } from "lucide-react";
import { useEffect } from "react";

/**
 * Landing page for the connect-code install popup. The connect-code step opens
 * the GitHub App install in a new tab with `next=/onboarding/connected`, so
 * GitHub's callback lands the popup here. We confirm and auto-close the tab (it
 * was script-opened, so `window.close()` is allowed); the original setup tab
 * detects the new installation via its poll and advances on its own. If the
 * browser refuses to close the tab, the message tells the user to close it.
 *
 * Public route (no auth gate): it does nothing sensitive, and gating it would
 * risk the onboarding redirect bouncing this throwaway tab elsewhere.
 */
export function GithubConnectedPage() {
  useEffect(() => {
    // A brief beat so the confirmation registers, then close.
    const timer = window.setTimeout(() => window.close(), 900);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      className="flex h-screen flex-col items-center justify-center text-center bg-background"
      style={{ gap: "var(--sp-3)", padding: "var(--sp-6)" }}
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center"
        style={{
          width: "var(--sp-10)",
          height: "var(--sp-10)",
          borderRadius: "var(--radius-full)",
          background: "color-mix(in oklch, var(--success) 16%, transparent)",
          color: "var(--success)",
        }}
      >
        <Check className="h-5 w-5" />
      </span>
      <p className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
        Connected
      </p>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)", maxWidth: "22rem" }}>
        You can close this tab — setup continues in your other tab.
      </p>
    </div>
  );
}
