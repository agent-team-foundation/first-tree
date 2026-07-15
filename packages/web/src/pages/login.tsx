import { ArrowLeft, Github, Lock, Zap } from "lucide-react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { readFromPath } from "../auth/redirect-from-state.js";
import { FirstTreeLogo } from "../components/first-tree-logo.js";
import { Button } from "../components/ui/button.js";

// Marketing site (parent brand) — the "Back to home" link points here rather
// than the in-app landing route. Mirrors the pattern in footer.tsx / layout.tsx.
const PARENT_URL = "https://first-tree.ai";
// Public source repo — the trust strip's "Open source" link.
const REPO_URL = "https://github.com/agent-team-foundation/first-tree";

/**
 * Sign-in entry. Single path: GitHub OAuth. The legacy password form has
 * been retired — pre-OAuth users are auto-migrated server-side by
 * `findOrCreateUserFromGithub`, which binds a fresh github identity to
 * any user whose `users.username` matches the GitHub login (case-
 * insensitive). They click "Continue with GitHub" once and keep their old
 * organization, agents, and history.
 *
 * On localhost a "Dev: skip GitHub" button is rendered alongside; it
 * jumps to `/auth/github/dev-callback` which mints a stub identity in
 * one round-trip without needing a real OAuth client. Production responds
 * 404 on that route, so the button is harmless even if shipped.
 *
 * The surface is wrapped in `.landing-marketing` (same class the in-app
 * landing page uses) so every token utility resolves to the first-tree.ai
 * dark palette — a single centered card on the near-black brand canvas.
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
  const googleHref =
    redirectTo === "/"
      ? "/api/v1/auth/google/start"
      : `/api/v1/auth/google/start?next=${encodeURIComponent(redirectTo)}`;

  // Stable dev identity — same id every time so reloads land on the same
  // user, agents, and conversations. Using `1` (not the more obvious 42)
  // makes test-suite collisions cheap to spot.
  const devCallbackHref = "/api/v1/auth/github/dev-callback?githubId=1&login=devuser&displayName=Dev+User";

  if (isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  return (
    // `landing-marketing` swaps the local --bg/--fg/--border tokens to the
    // first-tree.ai palette (near-black + cool-light), shared with the parent
    // brand. Scoping it here means the dashboard chrome stays unaffected.
    <div className="landing-marketing flex min-h-screen flex-col bg-background text-foreground">
      <header className="px-4 py-3">
        <a
          href={PARENT_URL}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-input)] px-2 py-1 text-body text-fg-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </a>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-sm rounded-[var(--radius-panel)] border border-border bg-card p-6 text-card-foreground shadow-[var(--shadow-sm)]">
          <div className="flex flex-col items-center space-y-1.5 text-center">
            <div className="mb-2 flex justify-center text-foreground">
              <FirstTreeLogo width={28} height={32} />
            </div>
            <div className="text-title">First Tree</div>
            <p className="text-label text-fg-2" style={{ marginTop: "var(--sp-1)" }}>
              Set up your team and your first AI agent.
            </p>
          </div>

          <div className="mt-6 space-y-4">
            <Button asChild className="w-full bg-foreground text-background hover:bg-foreground/90">
              <a href={googleHref}>
                <span className="flex h-4 w-4 items-center justify-center font-semibold">G</span>
                Continue with Google
              </a>
            </Button>

            <Button asChild className="w-full bg-foreground text-background hover:bg-foreground/90">
              <a href={githubHref}>
                <Github className="h-4 w-4" />
                Continue with GitHub
              </a>
            </Button>

            <p className="text-center text-label text-fg-3">
              <span className="font-medium text-fg-2">Sign in uses only your Google or GitHub identity.</span> You
              authorize a repo later, only when an agent needs to work in it.
            </p>

            <div className="flex items-center justify-center gap-4 border-t border-border pt-4 text-caption text-fg-3">
              <span className="inline-flex items-center gap-1.5">
                <Lock className="h-3 w-3" />
                No repo access yet
              </span>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-input)] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              >
                <Github className="h-3 w-3" />
                Open source
              </a>
            </div>

            <p className="text-center text-label text-fg-3">
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
                <div className="relative my-2 text-center text-label text-fg-3">
                  <span className="relative z-10 bg-card px-2">localhost only</span>
                  <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                </div>
                <Button asChild variant="outline" className="w-full">
                  <a href={devCallbackHref}>
                    <Zap className="h-4 w-4" />
                    Dev: skip GitHub
                  </a>
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
