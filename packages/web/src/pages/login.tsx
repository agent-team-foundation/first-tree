import { ArrowLeft, Github, Zap } from "lucide-react";
import { Link, Navigate, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { readFromPath } from "../auth/redirect-from-state.js";
import { FirstTreeLogo } from "../components/first-tree-logo.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";

/**
 * Sign-in entry. Single path: GitHub OAuth. The legacy password form has
 * been retired — pre-OAuth users are auto-migrated server-side by
 * `findOrCreateUserFromGithub`, which binds a fresh github identity to
 * any user whose `users.username` matches the GitHub login (case-
 * insensitive). They click "Continue with GitHub" once and keep their old
 * organization, agents, and history.
 *
 * On localhost dev shortcuts are rendered alongside; they jump to
 * `/auth/github/dev-callback` and mint a stub identity in one round-trip
 * without needing a real OAuth client. Production responds 404 on that
 * route, so the buttons are harmless even if shipped.
 */
export function LoginPage() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const redirectTo = readFromPath(location.state) ?? "/";
  // GitHub OAuth is a full-page navigation, so React Router state is
  // dropped on the way out. Pass the deep-link target through the
  // server's `?next=` instead — the server validates it via the same
  // safeRedirectPath helper and bakes it into the state JWT, so the
  // post-callback fragment carries it back to OAuthCompletePage.
  const githubHref =
    redirectTo === "/"
      ? "/api/v1/auth/github/start"
      : `/api/v1/auth/github/start?next=${encodeURIComponent(redirectTo)}`;

  // Stable dev identity — same id every time so reloads land on the same
  // user, agents, and conversations. Using `1` (not the more obvious 42)
  // makes test-suite collisions cheap to spot.
  const devCallbackHref = "/api/v1/auth/github/dev-callback?githubId=1&login=devuser&displayName=Dev+User";
  const devSkipOnboardingHref =
    "/api/v1/auth/github/dev-callback?githubId=1&login=devuser&displayName=Dev+User&skipOnboarding=1";

  if (isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="px-4 py-3">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-input)] px-2 py-1 text-body text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </Link>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <div className="mb-2 flex justify-center text-foreground">
              <FirstTreeLogo width={28} height={32} />
            </div>
            <CardTitle className="text-title">
              First Tree <span className="font-normal text-muted-foreground">Hub</span>
            </CardTitle>
            <p className="text-label text-muted-foreground" style={{ marginTop: "var(--sp-1)" }}>
              Sign in to set up your team and your first AI agent.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button asChild className="w-full">
              <a href={githubHref}>
                <Github className="h-4 w-4" />
                Sign in with GitHub
              </a>
            </Button>
            <p className="text-center text-label text-muted-foreground">
              By continuing you agree to our{" "}
              <a href="/terms" className="underline underline-offset-2 transition-colors hover:text-foreground">
                Terms
              </a>{" "}
              ·{" "}
              <a href="/privacy" className="underline underline-offset-2 transition-colors hover:text-foreground">
                Privacy
              </a>
            </p>
            {isLocalhost && (
              <>
                <div className="relative my-2 text-center text-label text-muted-foreground">
                  <span className="relative z-10 bg-card px-2">localhost only</span>
                  <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                </div>
                <Button asChild variant="outline" className="w-full">
                  <a href={devCallbackHref}>
                    <Zap className="h-4 w-4" />
                    Dev: skip GitHub
                  </a>
                </Button>
                <Button asChild variant="outline" className="w-full">
                  <a href={devSkipOnboardingHref}>
                    <Zap className="h-4 w-4" />
                    Dev: skip onboarding
                  </a>
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
