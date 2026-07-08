import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";

/**
 * Landing page for the GitHub App install popup — shared by every surface that
 * opens the install in a new tab with `next=/onboarding/connected`: onboarding
 * connect-code, the Context tab build entry, and Settings → GitHub. GitHub's
 * callback lands the popup here; we auto-close the tab (it was script-opened, so
 * `window.close()` is allowed) while the original tab detects the outcome via
 * its own poll. If the browser refuses to close the tab, the message tells the
 * user to close it.
 *
 * This page deliberately makes NO success claim. The same popup lands here for a
 * genuine install AND for a non-owner's approval-request bounce (the install is
 * pending an org owner's approval and nothing is connected yet), and the popup
 * has no signal to tell the two apart. So it stays neutral ("head back to the
 * tab you started from") and leaves the authoritative status to the origin tab,
 * which polls the real install state. A green "Connected" here would read as
 * false success for the pending-approval case.
 *
 * Public route (no auth gate): it does nothing sensitive, and gating it would
 * risk the redirect bouncing this throwaway tab elsewhere.
 */
export function GithubConnectedPage() {
  useEffect(() => {
    // A brief beat so the message registers, then close.
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
          background: "color-mix(in oklch, var(--fg) 8%, transparent)",
          color: "var(--fg-3)",
        }}
      >
        <ArrowLeft className="h-5 w-5" />
      </span>
      <p className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
        Back to First Tree
      </p>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)", maxWidth: "22rem" }}>
        You can close this tab — your status will appear in the tab you started from.
      </p>
    </div>
  );
}
