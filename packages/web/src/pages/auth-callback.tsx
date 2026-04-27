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

    void signInWithTokens({ accessToken: fragment.accessToken, refreshToken: fragment.refreshToken })
      .then(() => {
        // Scrub the fragment ONLY after the tokens are safely in storage.
        // Doing it before the await means a `signInWithTokens` rejection
        // (localStorage quota, private-mode Safari, transient
        // /me/workspaces 5xx) would leave the tokens lost on the user —
        // they'd have to redo the full GitHub OAuth round-trip just to
        // recover. After-success scrub plus an inline-retry on failure
        // (below) keeps the recovery path tractable.
        window.history.replaceState({}, "", window.location.pathname);
        navigate(fragment.next, { replace: true });
      })
      .catch(() => {
        // Don't navigate — leave the fragment in the URL so a page
        // refresh re-runs this handler and can succeed once the
        // transient cause clears.
        setError("storage_failed");
      });
  }, [navigate, signInWithTokens]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      {error ? (
        <div className="text-center space-y-3 max-w-sm">
          <div className="text-body text-destructive">Sign-in didn't complete.</div>
          <div className="text-caption text-muted-foreground">
            Refresh this page to try again, or{" "}
            <a href="/signup" className="underline">
              start over
            </a>
            .
          </div>
        </div>
      ) : (
        <div className="text-body text-muted-foreground">Signing you in…</div>
      )}
    </div>
  );
}
