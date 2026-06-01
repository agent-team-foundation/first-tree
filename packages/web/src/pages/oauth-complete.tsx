import { safeRedirectPath } from "@first-tree/shared";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { markOnboardingResume } from "../utils/onboarding-flags.js";

/**
 * Consumes the `#access=…&refresh=…&next=…` fragment that the server
 * appends after a successful GitHub callback. The fragment is ideal here:
 *   - browsers do NOT include it in the Referer header
 *   - it never enters server-side request logs
 *   - SPA can `replaceState` to wipe it from the URL bar
 *
 * Redirect targets are filtered through the same `safeRedirectPath` regex
 * the server uses, defense-in-depth against a tampered fragment.
 */
export function OAuthCompletePage() {
  const navigate = useNavigate();
  const { adoptTokens, selectOrganization } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access");
    const refreshToken = params.get("refresh");
    const next = safeRedirectPath(params.get("next"));
    const joinPath = params.get("joinPath");
    // The org this callback resolved to (invited org for an invite link).
    // Selecting it overrides any stale `selectedOrganizationId` left in
    // localStorage so an invitee lands in the org they just joined, not a
    // previously-used one.
    const org = params.get("org");

    if (!accessToken || !refreshToken) {
      setError("Sign-in did not complete. Please try again.");
      return;
    }

    // Stash the join path so the onboarding modal can pick context-aware copy
    // ("solo" vs "invite") on its first render. sessionStorage scope is
    // intentional — onboarding is a one-shot, and the flag is consumed and
    // cleared by the provider once it has used it.
    if (joinPath === "solo" || joinPath === "invite") {
      markOnboardingResume(joinPath);
    }

    // Wipe the fragment immediately — token sits in localStorage from here on.
    window.history.replaceState(null, "", window.location.pathname);

    void (async () => {
      await adoptTokens({ accessToken, refreshToken });
      // Set the active org BEFORE navigating so the workspace/onboarding
      // gate evaluates against the just-joined org rather than a stale one.
      if (org) await selectOrganization(org);
      navigate(next, { replace: true });
    })();
  }, [adoptTokens, selectOrganization, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-body text-muted-foreground">
      {error ?? "Signing you in…"}
    </div>
  );
}
