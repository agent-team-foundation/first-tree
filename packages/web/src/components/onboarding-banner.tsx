import { Sparkles, X } from "lucide-react";
import { useOnboardingState } from "../hooks/use-onboarding-state.js";

/**
 * Top-of-layout reminder shown to any signed-in user whose onboarding
 * wizard hasn't completed and who hasn't dismissed the banner. Replaces
 * the prior auto-popup modal — this is gentle, non-blocking, and the
 * user retains control (Get started or dismiss).
 *
 * Banner is rendered globally (every layout-rooted page), not just the
 * workspace, because "set up your first agent" is not a workspace-specific
 * task. Visibility is computed in `useOnboardingState`.
 */
export function OnboardingBanner() {
  const { bannerVisible, openModal, dismissBanner } = useOnboardingState();
  if (!bannerVisible) return null;

  return (
    <aside
      role="status"
      aria-label="Onboarding tip"
      className="shrink-0 flex items-center justify-between"
      style={{
        height: 44,
        padding: "0 var(--sp-3)",
        borderBottom: "var(--hairline) solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Sparkles className="h-3.5 w-3.5" style={{ color: "var(--primary)" }} />
        <span className="text-body" style={{ color: "var(--fg)" }}>
          Set up your first agent
        </span>
      </div>
      <div className="flex items-center" style={{ gap: 4 }}>
        <button
          type="button"
          onClick={openModal}
          className="inline-flex items-center text-body font-medium transition-colors"
          style={{
            padding: "var(--sp-1) var(--sp-2_5)",
            borderRadius: "var(--radius-input)",
            background: "var(--primary)",
            color: "var(--primary-foreground)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = "0.9";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = "1";
          }}
        >
          Get started
        </button>
        <button
          type="button"
          onClick={dismissBanner}
          aria-label="Dismiss"
          className="inline-flex items-center justify-center transition-colors"
          style={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius-input)",
            color: "var(--fg-3)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--fg)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--fg-3)";
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </aside>
  );
}
