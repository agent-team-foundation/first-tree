import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Check, Copy, Github } from "lucide-react";
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
  const [shareLinkUrl, setShareLinkUrl] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
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

  const handleRevealShareLink = async (): Promise<void> => {
    if (!organizationId || shareLinkUrl) return;
    setShareError(null);
    try {
      const url = await getGithubAppInstallUrl(organizationId, "/onboarding");
      setShareLinkUrl(url);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) setShareError(COPY.connectCode.notConfigured);
      else if (err instanceof ApiError && err.status === 403) setShareError(COPY.connectCode.notAdmin);
      else setShareError(COPY.errors.generic);
    }
  };

  const handleCopyShareLink = async (): Promise<void> => {
    if (!shareLinkUrl) return;
    await navigator.clipboard.writeText(shareLinkUrl);
    setShareCopied(true);
    window.setTimeout(() => setShareCopied(false), 1500);
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
                <button
                  type="button"
                  onClick={handleSkipClick}
                  className="text-label"
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                    color: "var(--fg-4)",
                  }}
                >
                  {COPY.skipForNow}
                </button>
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
                    <button
                      type="button"
                      onClick={() => setShowSkipConfirm(false)}
                      className="text-label"
                      style={{
                        background: "transparent",
                        border: 0,
                        padding: 0,
                        cursor: "pointer",
                        color: "var(--fg-4)",
                      }}
                    >
                      {COPY.cancel}
                    </button>
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

            {/* Non-owner share-link affordance, surfaced as a quiet sibling
                of the primary CTA so the user can find it without first
                failing on Install. Kept inline (not a separate dialog) so
                copy-paste-to-Slack stays one decision deep. */}
            <ShareWithAdmin
              expanded={!!shareLinkUrl}
              url={shareLinkUrl}
              copied={shareCopied}
              error={shareError}
              onReveal={() => void handleRevealShareLink()}
              onCopy={() => void handleCopyShareLink()}
            />

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
              style={{ color: "var(--accent)" }}
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

/**
 * Quiet "I'm not the GitHub org owner" affordance. Collapsed by default
 * (one line + chevron); expanded reveals the install URL + a Copy button.
 * The link is generated lazily on expand to avoid burning a state JWT for
 * users who never use it.
 */
function ShareWithAdmin({
  expanded,
  url,
  copied,
  error,
  onReveal,
  onCopy,
}: {
  expanded: boolean;
  url: string | null;
  copied: boolean;
  error: string | null;
  onReveal: () => void;
  onCopy: () => void;
}) {
  if (!expanded) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
        <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
          {COPY.connectCode.notOwnerToggle}
        </p>
        <button
          type="button"
          onClick={onReveal}
          className="text-label self-start"
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--accent)" }}
        >
          → Get a link for your GitHub admin
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <p className="text-label" style={{ margin: 0, color: "var(--fg-2)" }}>
        {COPY.connectCode.notOwnerIntro}
      </p>
      {error ? (
        <FlowNote>{error}</FlowNote>
      ) : (
        <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
          <div
            className="text-label"
            title={url ?? undefined}
            style={{
              flex: 1,
              minHeight: 38,
              padding: "var(--sp-2_5) var(--sp-3)",
              background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
              border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg-2)",
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {url ?? "Generating link…"}
          </div>
          <button
            type="button"
            onClick={onCopy}
            disabled={!url}
            className="inline-flex items-center justify-center text-label font-medium"
            style={{
              gap: "var(--sp-1_5)",
              padding: "0 var(--sp-3)",
              minHeight: 38,
              background: "color-mix(in oklch, var(--bg-raised) 48%, transparent)",
              border: "var(--hairline) solid color-mix(in oklch, var(--border) 58%, transparent)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg-2)",
              cursor: url ? "pointer" : "not-allowed",
              opacity: url ? 1 : 0.6,
            }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
      {!error && (
        <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
          {COPY.connectCode.notOwnerAfter}
        </p>
      )}
    </div>
  );
}
