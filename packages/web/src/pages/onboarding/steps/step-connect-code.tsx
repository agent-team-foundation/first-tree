import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Github } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "../../../api/client.js";
import { listGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallation, getGithubAppInstallUrl } from "../../../api/github-app.js";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { FlowNote, RepoPicker, StatusRow } from "../flow-ui.js";
import { InstallGuide, ShowMeHow } from "../guides.js";
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
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [postAttemptStuck, setPostAttemptStuck] = useState(false);

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

  const reposQuery = useQuery({
    queryKey: ["onboarding", "github-repos"],
    queryFn: listGithubRepos,
    enabled: installed,
  });
  const scopeMissing = reposQuery.error instanceof ApiError && reposQuery.error.status === 403;
  const hasPickableRepos = !scopeMissing && (reposQuery.data?.length ?? 0) > 0;

  const handleConnect = async (): Promise<void> => {
    if (!organizationId) return;
    setInstallError(null);
    setRedirecting(true);
    try {
      const url = await getGithubAppInstallUrl(organizationId, "/onboarding");
      window.sessionStorage.setItem(INSTALL_ATTEMPT_KEY, String(Date.now()));
      window.location.assign(url);
    } catch (err) {
      setRedirecting(false);
      if (err instanceof ApiError && err.status === 503) setInstallError("not_configured");
      else if (err instanceof ApiError && err.status === 403) setInstallError("not_admin");
      else setInstallError("generic");
    }
  };

  const handleSkipClick = (): void => setShowSkipConfirm(true);
  const handleSkipConfirmed = (): void => {
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
            <FlowNote tone="info">{COPY.connectCode.notConfigured}</FlowNote>
            <ContinueWithout onClick={goNext} />
          </>
        ) : installError === "not_admin" ? (
          <>
            <FlowNote tone="info">{COPY.connectCode.notAdmin}</FlowNote>
            <ContinueWithout onClick={goNext} />
          </>
        ) : (
          <>
            {/* Decision row: primary CTA + Skip as a quiet sibling. Both
                actions visible side-by-side so the user sees their full set
                of options at a glance instead of hunting for Skip in a
                footer. */}
            <div className="flex items-center" style={{ gap: "var(--sp-4)", flexWrap: "wrap" }}>
              <Button type="button" onClick={() => void handleConnect()} disabled={redirecting || !organizationId}>
                <Github className="h-4 w-4" />
                {COPY.connectCode.cta}
              </Button>
              {!showSkipConfirm && (
                <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={handleSkipClick}>
                  {COPY.skipForNow}
                </Button>
              )}
            </div>

            {showSkipConfirm && (
              <FlowNote tone="info">
                <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
                  <p className="font-medium" style={{ margin: 0, color: "var(--fg)" }}>
                    {COPY.connectCode.skipWarningTitle}
                  </p>
                  <ul style={{ margin: 0, paddingLeft: "var(--sp-4)" }}>
                    {COPY.connectCode.skipWarningBullets.map((bullet) => (
                      <li key={bullet} style={{ color: "var(--fg-3)" }}>
                        {bullet}
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-1)" }}>
                    <Button type="button" variant="outline" onClick={handleSkipConfirmed}>
                      {COPY.connectCode.skipAnyway}
                    </Button>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-label"
                      onClick={() => setShowSkipConfirm(false)}
                    >
                      {COPY.cancel}
                    </Button>
                  </div>
                </div>
              </FlowNote>
            )}

            {installError === "generic" && <FlowNote>{COPY.errors.generic}</FlowNote>}
            <StatusRow state="waiting" label={COPY.connectCode.waiting} />

            {postAttemptStuck && (
              <FlowNote tone="info">
                <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
                  <p className="font-medium" style={{ margin: 0, color: "var(--fg)" }}>
                    {COPY.connectCode.postAttemptStuckTitle}
                  </p>
                  <p style={{ margin: 0, color: "var(--fg-3)" }}>{COPY.connectCode.postAttemptStuckBody}</p>
                </div>
              </FlowNote>
            )}

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

            <ShowMeHow>
              <InstallGuide />
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
          <FlowNote tone="info">
            <a
              href="/api/v1/auth/github/start?next=/onboarding"
              className="font-medium"
              style={{ color: "var(--primary)" }}
            >
              {COPY.connectCode.reconnect}
            </a>
          </FlowNote>
        ) : reposQuery.isLoading ? (
          <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
            Loading your projects…
          </p>
        ) : (reposQuery.data?.length ?? 0) === 0 ? (
          <FlowNote tone="info">{COPY.connectCode.noRepos}</FlowNote>
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
