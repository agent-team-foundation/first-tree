import { Navigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";

/**
 * `/signup` — single-button GitHub sign-in entry. Per the design doc §4.2:
 * "页面只有一个大按钮：Continue with GitHub". This page never collects user
 * input itself; the click 302-redirects through the server's
 * `/api/v1/auth/github/start` endpoint so the OAuth state cookie can be
 * set as part of the response.
 *
 * `?next=/invite/<token>` is preserved across the round-trip — the server
 * embeds it in the state JWT and `completeSignIn` honours it after the
 * GitHub callback so an invite-link click that bounces through sign-in
 * lands the user on the invite acceptance page, not on `/setup`.
 *
 * `?error=` is the single failure surface — the server's redirect can land
 * back on `/signup?error=oauth_failed` if the callback throws. Today we
 * just surface a generic message; nicer mapping is a polish PR.
 */
export function SignupPage() {
  const { isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next") ?? "/";
  const error = searchParams.get("error");

  // Already signed in: jump them out of the entry funnel. The router-level
  // gates take it from here (rootless → /setup; per-org → /).
  if (isAuthenticated) {
    return <Navigate to={next} replace />;
  }

  // Server-side `/start` builds the GitHub authorize URL (or the dev-stub
  // bounce in non-production deployments) and sets the CSRF cookie. Anchor
  // tag rather than fetch() because the response is a 302 — the browser
  // follows naturally and the Set-Cookie header sticks.
  const startUrl = `/api/v1/auth/github/start?next=${encodeURIComponent(next)}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-title">First Tree Hub</CardTitle>
          <CardDescription>Sign in to your workspace</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-body text-destructive">
              Sign-in didn't complete. Please try again.
            </div>
          )}
          <Button asChild className="w-full">
            <a href={startUrl}>Continue with GitHub</a>
          </Button>
          <p className="text-caption text-muted-foreground text-center">
            By continuing, you agree to our terms — privacy and tos pages coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
