import { safeRedirectPath } from "@agent-team-foundation/first-tree-hub-shared";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/auth-context.js";

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
  const { adoptTokens } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access");
    const refreshToken = params.get("refresh");
    const next = safeRedirectPath(params.get("next"));
    const joinPath = params.get("joinPath");

    if (!accessToken || !refreshToken) {
      setError("Sign-in did not complete. Please try again.");
      return;
    }

    // Stash the join path so the onboarding modal can pick context-aware copy
    // ("solo" vs "invite") on its first render. sessionStorage scope is
    // intentional — onboarding is a one-shot, and the flag is consumed and
    // cleared by the modal once it has used it.
    if (joinPath === "solo" || joinPath === "invite") {
      sessionStorage.setItem("onboarding:joinPath", joinPath);
      sessionStorage.setItem("onboarding:autoOpen", "1");
    }

    // Wipe the fragment immediately — token sits in localStorage from here on.
    window.history.replaceState(null, "", window.location.pathname);

    void (async () => {
      await adoptTokens({ accessToken, refreshToken });
      navigate(next, { replace: true });
    })();
  }, [adoptTokens, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-body text-muted-foreground">
      {error ?? "Signing you in…"}
    </div>
  );
}
