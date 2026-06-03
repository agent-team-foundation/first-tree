import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Github } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../../../api/client.js";
import { listOrgGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallation, getGithubAppInstallUrl } from "../../../api/github-app.js";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { FlowHint, RepoPicker, StatusRow } from "../flow-ui.js";
import { InstallGuide, InstallTroubleshooting, ShowMeHow } from "../guides.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Session marker — set when the user clicks "Install First Tree on GitHub"
 * so we can detect "came back without an install" on the next render.
 * Cleared once an install is observed or the user skips. Per-tab so we
 * never confuse a different login attempt's state.
 */
const INSTALL_ATTEMPT_KEY = "onboarding:connect-code:install-attempt";

/**
 * Admin step: install the GitHub App (the only reliable code-connection
 * entry — `installations/new`, not the sign-in `authorize` URL), then pick
 * the project the agent should help with.
 *
 * Resilient by design — the team's first run can hit any of: App not
 * installed, App not configured on this server, caller isn't an admin,
 * GitHub access lacks project scope, no repos, or — the trickiest — the
 * admin isn't a GitHub org owner and gets bounced back from the install
 * dialog without anything installed. Each case gets a plain message and
 * a way forward (never a dead end).
 */
export function StepConnectCode() {
  const { organizationId, goNext, selectedRepoUrls, setSelectedRepoUrls } = useOnboardingFlow();
  const [installError, setInstallError] = useState<"not_configured" | "not_admin" | "generic" | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [postAttemptStuck, setPostAttemptStuck] = useState(false);
  // Whether the user has actually kicked off an install (this tab). We only
  // show the "Waiting for GitHub…" status once they have — before the first
  // click there's nothing to wait for, and a pre-action "Waiting…" reads as
  // "waiting for what? I haven't done anything."
  const [attempted, setAttempted] = useState(
    () => typeof window !== "undefined" && !!window.sessionStorage.getItem(INSTALL_ATTEMPT_KEY),
  );

  const installQuery = useQuery({
    queryKey: ["onboarding", "installation", organizationId],
    queryFn: () => getGithubAppInstallation(organizationId ?? ""),
    enabled: !!organizationId,
    // Poll until an install appears (e.g. the user just came back from
    // GitHub's install dialog); stop once we have one.
    refetchInterval: (query) => (query.state.data ? false : 4000),
  });

  const installed = !!installQuery.data;

  // Detect "user clicked Install, went to GitHub, came back without an
  // install row". If we observe the attempt marker but still no installation
  // a few seconds after the query has settled, surface a soft hint with
  // recovery options. (Polling continues, so a slow webhook still wins.)
  useEffect(() => {
    if (installed) {
      window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
      setPostAttemptStuck(false);
      return;
    }
    if (typeof window === "undefined") return;
    const attempted = window.sessionStorage.getItem(INSTALL_ATTEMPT_KEY);
    if (!attempted) return;
    if (installQuery.isLoading) return;
    // Give the post-redirect webhook a moment before crying foul.
    const t = window.setTimeout(() => setPostAttemptStuck(true), 5000);
    return () => window.clearTimeout(t);
  }, [installed, installQuery.isLoading]);

  // "Need help?" auto-opens when the user returns from GitHub without an
  // install — same "stuck → help opens" behavior as connect-computer (just
  // triggered by a failed return rather than a timer).
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (postAttemptStuck) setHelpOpen(true);
  }, [postAttemptStuck]);

  // Team-by-default: the admin picks from the team's *org* code, sourced
  // from the GitHub App installation's repo grant (not the admin's personal
  // `/user/repos`). Only repos the agent can actually reach show up.
  const reposQuery = useQuery({
    queryKey: ["onboarding", "org-github-repos", organizationId],
    queryFn: () => listOrgGithubRepos(organizationId ?? ""),
    enabled: installed && !!organizationId,
  });
  const scopeMissing = reposQuery.error instanceof ApiError && reposQuery.error.status === 403;
  // The installation-backed endpoint can fail with 502 (upstream) / 503
  // (no_installation / suspended / not_configured). Treat any non-403 error
  // as a load failure with an honest message rather than letting it fall
  // through to the empty "no projects" state.
  const loadFailed = !!reposQuery.error && !scopeMissing;
  const hasPickableRepos = !reposQuery.error && (reposQuery.data?.length ?? 0) > 0;

  const handleConnect = async (): Promise<void> => {
    if (!organizationId) return;
    setInstallError(null);
    setRedirecting(true);
    try {
      const url = await getGithubAppInstallUrl(organizationId, "/onboarding");
      window.sessionStorage.setItem(INSTALL_ATTEMPT_KEY, String(Date.now()));
      setAttempted(true);
      window.location.assign(url);
    } catch (err) {
      setRedirecting(false);
      if (err instanceof ApiError && err.status === 503) setInstallError("not_configured");
      else if (err instanceof ApiError && err.status === 403) setInstallError("not_admin");
      else setInstallError("generic");
    }
  };

  // Skipping is a legitimate, fully-recoverable choice (re-connect anytime
  // from Settings), so it goes straight through — no confirm gate. The
  // always-visible `skipReassure` line below the CTA makes the choice
  // informed before the click rather than shamed after it.
  const handleSkip = (): void => {
    window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
    goNext();
  };

  const toggleRepo = (cloneUrl: string): void => {
    setSelectedRepoUrls(
      selectedRepoUrls.includes(cloneUrl)
        ? selectedRepoUrls.filter((u) => u !== cloneUrl)
        : [...selectedRepoUrls, cloneUrl],
    );
  };

  // ── Not connected yet ────────────────────────────────────────────────
  if (!installed) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {/* Intro is now embedded into the step `why` via STEP_COPY — no
            separate reassurance paragraph (folded into why) and no
            "alreadyInstalledHint" (the share-link affordance below covers
            the same recovery path more clearly). */}

        {installError === "not_configured" ? (
          <>
            <FlowHint>{COPY.connectCode.notConfigured}</FlowHint>
            <ContinueWithout onClick={goNext} />
          </>
        ) : installError === "not_admin" ? (
          <>
            <FlowHint>{COPY.connectCode.notAdmin}</FlowHint>
            <ContinueWithout onClick={goNext} />
          </>
        ) : (
          <>
            {/* Decision row: primary CTA + Skip as a quiet sibling. Both
                actions visible side-by-side so the user sees their full set
                of options at a glance instead of hunting for Skip in a
                footer. Skip goes straight through (no confirm gate); the
                muted reassurance line below keeps the choice informed. */}
            <div className="flex items-center" style={{ gap: "var(--sp-4)", flexWrap: "wrap" }}>
              <Button type="button" onClick={() => void handleConnect()} disabled={redirecting || !organizationId}>
                <Github className="h-4 w-4" />
                {COPY.connectCode.cta}
              </Button>
              <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={handleSkip}>
                {COPY.skipForNow}
              </Button>
            </div>
            <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
              {COPY.connectCode.skipReassure}
            </p>

            {installError === "generic" && (
              <FlowHint tone="error" role="alert">
                {COPY.errors.generic}
              </FlowHint>
            )}
            {/* Status only after the user has actually started an install:
                before the first click there's nothing to wait for, so showing
                "Waiting for GitHub…" up front reads as "waiting for what?".
                Once they come back without an install, a flat "Waiting…" would
                contradict the auto-opened help that says it didn't go through —
                swap to a guidance line that points there. */}
            {postAttemptStuck ? (
              <FlowHint>{COPY.connectCode.stuckStatus}</FlowHint>
            ) : attempted ? (
              <StatusRow state="waiting" label={COPY.connectCode.waiting} />
            ) : null}

            {/* Non-owner hint. We can't hand the user a shareable install
                URL because the OAuth state JWT is paired with a per-browser
                `oauth_state_nonce` cookie — a copied URL opened in the org
                owner's browser would fail the callback's state-nonce check.
                Instead, lean on GitHub's own "request approval" flow: if a
                non-owner clicks the Install button, GitHub itself routes
                the request to org owners for approval, and once approved
                the bounce-back lands in the original (cookie-bearing)
                browser. So: just tell them to click Install anyway.
                Server-side shareable links (signed token instead of cookie
                nonce) is a follow-up. */}
            <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
              {COPY.connectCode.notOwnerHint}
            </p>

            <ShowMeHow open={helpOpen} onToggle={setHelpOpen}>
              <InstallGuide />
              <InstallTroubleshooting />
            </ShowMeHow>
          </>
        )}
      </div>
    );
  }

  // ── Connected — pick the project ─────────────────────────────────────
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <StatusRow state="ok" label={COPY.connectCode.connected} />

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
          {COPY.connectCode.pickProject}
        </p>

        {scopeMissing ? (
          <FlowHint>
            {COPY.connectCode.scopeMissing}{" "}
            <a
              href="/api/v1/auth/github/start?next=/onboarding"
              className="font-medium"
              style={{ color: "var(--primary)" }}
            >
              {COPY.connectCode.reconnect}
            </a>
          </FlowHint>
        ) : reposQuery.isLoading ? (
          <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
            Loading your projects…
          </p>
        ) : loadFailed ? (
          <FlowHint tone="error" role="alert">
            {COPY.connectCode.loadFailed}
          </FlowHint>
        ) : (reposQuery.data?.length ?? 0) === 0 ? (
          <FlowHint>{COPY.connectCode.noRepos}</FlowHint>
        ) : (
          <RepoPicker repos={reposQuery.data ?? []} selected={selectedRepoUrls} onToggle={toggleRepo} fill />
        )}
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        {hasPickableRepos && selectedRepoUrls.length === 0 && (
          <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
            {COPY.connectCode.pickHint}
          </p>
        )}
        {/* Primary is never disabled: with a project it binds, without one it
            continues anyway — a beginner should never face a dead button. */}
        <Button type="button" onClick={goNext} className="self-start">
          <span>{selectedRepoUrls.length > 0 ? COPY.continue : COPY.connectCode.continueNoProject}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ContinueWithout({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex">
      <Button type="button" variant="outline" onClick={onClick}>
        <span>{COPY.connectCode.continueWithout}</span>
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
