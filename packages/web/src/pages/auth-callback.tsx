import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { parseAuthFragment } from "../utils/auth-fragment.js";

/**
 * `/auth/github/complete` — receives the OAuth result from the server's
 * `/api/v1/auth/github/callback` 302. The server packs the access token,
 * refresh token, and `nextRoute` into the URL fragment; we read them
 * here, persist to localStorage via `signInWithTokens`, scrub the
 * fragment from the browser history, and forward the user to the
 * intended destination.
 *
 * Why a fragment: tokens never leave the browser (no proxy / CDN access
 * log), and the SPA can clear them via `replaceState` before any
 * subsequent page-refresh would bookmark them.
 *
 * Failure modes (no fragment, missing fields) bounce back to `/signup`
 * with a generic `error=oauth_failed` so the user can retry — same
 * shape as the server-side error path.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const { signInWithTokens } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    // Strict-mode mounts effects twice in dev — without this guard we'd
    // try to consume the fragment twice and the second pass would land
    // on the bounce-to-signup branch because the first pass already
    // cleared the URL.
    if (ranRef.current) return;
    ranRef.current = true;

    const fragment = parseAuthFragment(window.location.hash);
    if (!fragment) {
      setError("oauth_failed");
      navigate("/signup?error=oauth_failed", { replace: true });
      return;
    }

    // Scrub the fragment before any other render — no point persisting
    // tokens in browser history once they're in localStorage.
    window.history.replaceState({}, "", window.location.pathname);

    void signInWithTokens({ accessToken: fragment.accessToken, refreshToken: fragment.refreshToken })
      .then(() => navigate(fragment.next, { replace: true }))
      .catch(() => {
        setError("storage_failed");
        navigate("/signup?error=storage_failed", { replace: true });
      });
  }, [navigate, signInWithTokens]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-body text-muted-foreground">
        {error ? "Sign-in didn't complete. Redirecting…" : "Signing you in…"}
      </div>
    </div>
  );
}
