import { Check } from "lucide-react";
import { useEffect } from "react";

/**
 * Landing page for the GitHub App install popup — shared by every surface that
 * opens the install in a new tab with `next=/onboarding/connected`: onboarding
 * connect-code, the Context tab build entry, and Settings → GitHub. GitHub's
 * callback lands the popup here; we confirm and auto-close the tab (it was
 * script-opened, so `window.close()` is allowed) while the original tab detects
 * the new installation via its poll and updates on its own. If the browser
 * refuses to close the tab, the message tells the user to close it. Copy is kept
 * surface-neutral ("the other tab will update") so it reads correctly whether the
 * origin tab is an onboarding wizard or a settings page.
 *
 * Public route (no auth gate): it does nothing sensitive, and gating it would
 * risk the redirect bouncing this throwaway tab elsewhere.
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
        You can close this tab — the other tab will update.
      </p>
    </div>
  );
}
