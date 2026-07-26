import type { GithubAppInstallationOutput } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Building2, Check, Github, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../api/client.js";
import { listOrgGithubRepos } from "../../../api/github.js";
import { getGithubAppInstallation, getGithubAppInstallUrl } from "../../../api/github-app.js";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { FlowHint, RepoTokenPicker, StatusRow } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Session marker — set when the user clicks "Install on GitHub"
 * so we can detect "came back without an install" on the next render.
 * Cleared once an install is observed or the user skips. Per-tab so we
 * never confuse a different login attempt's state.
 */
const INSTALL_ATTEMPT_KEY = "onboarding:connect-code:install-attempt";

/**
 * RETENTION NOTE (read before assuming this runs during onboarding): this step
 * is intentionally NOT in the main onboarding sequence. The value-first redesign
 * dropped GitHub connection from the critical path so a user reaches their agent
 * first (see `ADMIN_STEPS` / `INVITEE_STEPS` in steps.ts — neither lists it).
 * It is deliberately KEPT — still rendered by the dev onboarding preview and
 * reused (via `RepoTokenPicker`) by the Context-tab tree build entry — and may
 * be re-added to onboarding later, so it is not dead code. But nothing in the
 * live admin/invitee flow mounts it or populates `selectedRepoUrls`; do not read
 * this component as part of the normal onboarding path.
 *
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
  const { organizationId, goNext, selectedRepoUrls, setSelectedRepoUrls, hasRepoDraft, reportStepFailure } =
    useOnboardingFlow();
  const [installError, setInstallError] = useState<"not_configured" | "not_admin" | "generic" | null>(null);
  const [redirecting, setRedirecting] = useState(false);
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

  // In the new-tab flow the original tab never navigates away — it just keeps
  // polling (above) and advances once the installation row appears. So we can't
  // infer "stuck" from elapsed time: a timer would fire mid-install, and
  // re-enabling the CTA on it let a second mint overwrite the first attempt's
  // `oauth_state_nonce` cookie and break its callback. Recovery is instead an
  // explicit, user-initiated "Start over" (handleStartOver). Here we only clear
  // the attempt marker once the install actually lands.
  useEffect(() => {
    if (installed) window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
  }, [installed]);

  // Team-by-default: the admin picks from the team's *org* code, sourced
  // from the GitHub App installation's repo grant (not the admin's personal
  // `/user/repos`). Only repos the agent can actually reach show up.
  const reposQuery = useQuery({
    queryKey: ["onboarding", "org-github-repos", organizationId],
    queryFn: () => listOrgGithubRepos(organizationId ?? ""),
    enabled: installed && !!organizationId,
  });
  // Any repo-list error → one honest "couldn't load" message. The repos come
  // from the App *installation* token (server-minted), not the caller's OAuth,
  // so failures are 502 (upstream) / 503 (no_installation / suspended /
  // not_configured). A 403 here is `requireOrgAdmin` ("not an org admin"), not
  // a GitHub-scope problem — and connect-code is admin-only, so it's
  // effectively unreachable; a "reconnect GitHub" wouldn't fix it anyway.
  const loadFailed = !!reposQuery.error;
  const hasPickableRepos = !reposQuery.error && (reposQuery.data?.length ?? 0) > 0;
  const reportedRepoLoadFailureRef = useRef(false);
  useEffect(() => {
    if (!loadFailed || reportedRepoLoadFailureRef.current) return;
    reportedRepoLoadFailureRef.current = true;
    reportStepFailure("github_repo_list_failed", { step: "connect-code" });
  }, [loadFailed, reportStepFailure]);

  // Default to NONE selected: the user actively picks which repos to share
  // (paired with the "Skip for now" out + the no-repo consequence hint). When
  // resuming a saved draft, keep the user's choices but drop repos the GitHub
  // App no longer grants.
  useEffect(() => {
    const loaded = reposQuery.data;
    if (!hasRepoDraft || !loaded || loaded.length === 0) return;
    const grantedUrls = new Set(loaded.map((r) => r.cloneUrl));
    const pruned = selectedRepoUrls.filter((url) => grantedUrls.has(url));
    if (pruned.length !== selectedRepoUrls.length) setSelectedRepoUrls(pruned);
  }, [hasRepoDraft, reposQuery.data, selectedRepoUrls, setSelectedRepoUrls]);

  const handleConnect = async (): Promise<void> => {
    if (!organizationId) return;
    setInstallError(null);
    setRedirecting(true);
    // Open the tab synchronously inside the click gesture so the browser doesn't
    // treat the post-await window.open as a blocked popup; fill its location once
    // the install URL is minted (or close it on failure). GitHub installs in that
    // tab and lands it on /onboarding/connected to auto-close, while this tab
    // keeps polling and advances on its own.
    const installTab = window.open("", "_blank");
    const postInstallNext = installTab ? "/onboarding/connected" : "/onboarding";
    try {
      const url = await getGithubAppInstallUrl(organizationId, postInstallNext);
      window.sessionStorage.setItem(INSTALL_ATTEMPT_KEY, String(Date.now()));
      setAttempted(true);
      if (installTab) installTab.location.href = url;
      else window.location.assign(url); // popup blocked — fall back to a full redirect
      setRedirecting(false);
    } catch (err) {
      installTab?.close();
      setRedirecting(false);
      if (err instanceof ApiError && err.status === 503) {
        setInstallError("not_configured");
        reportStepFailure("github_install_not_configured", { step: "connect-code", retryable: false });
      } else if (err instanceof ApiError && err.status === 403) {
        setInstallError("not_admin");
        reportStepFailure("github_install_forbidden", { step: "connect-code", retryable: false });
      } else {
        setInstallError("generic");
        reportStepFailure("github_install_url_failed", { step: "connect-code" });
      }
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

  // Explicit, user-initiated retry: abandon the in-flight attempt and re-enable
  // the CTA for a fresh mint. Deliberate by design — a new install URL
  // overwrites the `oauth_state_nonce` cookie, so this must be a conscious
  // "the GitHub tab didn't work, start fresh", never an auto-unlocked re-click.
  const handleStartOver = (): void => {
    window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
    setAttempted(false);
    setInstallError(null);
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
        {/* One merged step (no in-step phase bar): Install → the repo list
            appears in place. Intro/why live in STEP_COPY. */}

        {installError === "not_configured" || installError === "not_admin" ? (
          // Just the message — the unified "Skip for now" at the bottom of the
          // step is the way forward.
          <FlowHint>{COPY.connectCode.cantConnect}</FlowHint>
        ) : (
          <>
            {/* Primary CTA only — "Skip for now" lives at the bottom of the step
                (unified across states), so Install reads as the one clear primary
                action here rather than competing with a sibling skip. */}
            <div className="flex">
              {/* Lock the CTA once an attempt is in flight. The original tab
                  never navigates away here, so a second mint would overwrite the
                  first attempt's `oauth_state_nonce` cookie and break its
                  callback — retry is the explicit "Start over" below, never a
                  timed auto-unlock. */}
              <Button
                type="button"
                onClick={() => void handleConnect()}
                disabled={redirecting || attempted || !organizationId}
              >
                <Github className="h-4 w-4" />
                {COPY.connectCode.cta}
              </Button>
            </div>
            {/* Merged caveat + skip reassurance; the gating fact is bolded. */}
            <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
              {COPY.connectCode.notOwnerHint.pre}
              <span className="font-medium" style={{ color: "var(--fg-3)" }}>
                {COPY.connectCode.notOwnerHint.emphasis}
              </span>
              {COPY.connectCode.notOwnerHint.post}
            </p>

            {installError === "generic" && (
              <FlowHint tone="error" role="alert">
                {COPY.errors.generic}
              </FlowHint>
            )}
            {/* Status only after the user has actually started an install:
                before the first click there's nothing to wait for. The original
                tab keeps polling and advances on its own once the install lands;
                if the GitHub tab didn't work, "Start over" re-mints (the only
                safe way to retry — see the CTA-lock note above). */}
            {attempted ? (
              // Stuck install recovery: the live "waiting" status + a re-mint retry.
              // notOwnerHint above
              // already covers who can install / owner approval, so no extra
              // troubleshooting line here.
              <div className="flex items-center" style={{ gap: "var(--sp-2_5)", flexWrap: "wrap" }}>
                <StatusRow state="waiting" label={COPY.connectCode.waiting} />
                <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={handleStartOver}>
                  {COPY.connectCode.restartInstall}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {/* Unified "Skip for now" at the bottom — the same quiet link in every
            not-installed state (was beside the CTA / under the error message).
            handleSkip clears any in-flight install marker first. */}
        <Button
          type="button"
          variant="link"
          className="h-auto self-start p-0 text-label underline underline-offset-2"
          onClick={handleSkip}
        >
          {COPY.skipForNow}
        </Button>
      </div>
    );
  }

  // ── Connected — pick the project ─────────────────────────────────────
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      {/* Confirm WHICH GitHub account/org the App landed on — the install
          account is whoever's github.com session was active at install time,
          not necessarily the First Tree login account, so name it explicitly
          before the repo pick. */}
      {installQuery.data && (
        <ConnectedBanner
          installation={installQuery.data}
          // Show the granted-repo count once the list has actually resolved —
          // including 0 (loaded-but-empty is a real, informative count). Stay
          // null while loading or on error, where a count would be a guess.
          repoCount={reposQuery.isSuccess ? (reposQuery.data?.length ?? 0) : null}
        />
      )}

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        {/* The "which repos" prompt only makes sense when there's a list to
            pick from — in loading / load-failed / empty states it would ask
            the user to choose repos we can't even show. */}
        {hasPickableRepos && (
          <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
            {COPY.connectCode.pickProject}
          </p>
        )}

        {reposQuery.isLoading ? (
          <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
            {COPY.connectCode.loading}
          </p>
        ) : loadFailed ? (
          <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
            <FlowHint tone="error" role="alert">
              {COPY.connectCode.loadFailed}
            </FlowHint>
          </div>
        ) : (reposQuery.data?.length ?? 0) === 0 ? (
          <FlowHint>{COPY.connectCode.noRepos}</FlowHint>
        ) : (
          // Onboarding: search + selected-chips-in-field token picker, default none.
          <RepoTokenPicker
            repos={reposQuery.data ?? []}
            selected={selectedRepoUrls}
            onToggle={toggleRepo}
            onClear={() => setSelectedRepoUrls([])}
          />
        )}
      </div>

      <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
        {selectedRepoUrls.length > 0 ? (
          // Happy path: a repo is picked → bind it. Strong primary.
          <Button type="button" onClick={goNext} className="self-start">
            <span>{COPY.continue}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          // No repo (didn't pick / couldn't load / none exist): continuing
          // without one is never the desired path, so it's always a very weak
          // muted micro-link — never a strong button. Unified skip: same
          // "Skip for now" label + quiet link style as the pre-connect skip, so
          // the skip reads identically in every state.
          <Button
            type="button"
            variant="link"
            className="h-auto self-start p-0 text-label underline underline-offset-2"
            onClick={goNext}
          >
            {COPY.skipForNow}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Post-install confirmation banner: names the GitHub account/org the App is now
 * connected to (plus the granted-repo count once the list loads). The install
 * account is set by whichever github.com session was active at install time —
 * which need not be the account the user signed into First Tree with — so
 * surfacing it here lets the user catch a wrong-account/org install before they
 * pick repos. Mirrors the Settings → GitHub "Connected as" idiom (account icon +
 * login + type chip) for visual consistency.
 */
function ConnectedBanner({
  installation,
  repoCount,
}: {
  installation: GithubAppInstallationOutput;
  repoCount: number | null;
}) {
  const AccountIcon = installation.accountType === "Organization" ? Building2 : User;
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-2) var(--sp-3)",
        background: "var(--bg-sunken)",
        borderRadius: "var(--radius-input)",
        flexWrap: "wrap",
      }}
    >
      <Check className="h-4 w-4" style={{ color: "var(--primary)", flexShrink: 0 }} aria-hidden="true" />
      <span className="text-label" style={{ color: "var(--fg-3)" }}>
        {COPY.connectCode.connected.label}
      </span>
      <AccountIcon className="h-4 w-4" style={{ color: "var(--fg-2)", flexShrink: 0 }} aria-hidden="true" />
      <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
        {installation.accountLogin}
      </span>
      <span
        className="text-label"
        style={{
          padding: "var(--sp-0_5) var(--sp-1_5)",
          background: "var(--bg)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg-3)",
        }}
      >
        {installation.accountType}
      </span>
      {repoCount !== null && (
        <span className="text-label" style={{ color: "var(--fg-4)", marginLeft: "auto" }}>
          {COPY.connectCode.connected.repoCount(repoCount)}
        </span>
      )}
    </div>
  );
}
