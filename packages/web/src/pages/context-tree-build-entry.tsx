import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Github, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listManagedAgents, type ManagedAgent } from "../api/agents.js";
import { ApiError } from "../api/client.js";
import { listOrgGithubRepos } from "../api/github.js";
import { getGithubAppInstallation, getGithubAppInstallUrl } from "../api/github-app.js";
import { listTeamResourcesForOrg } from "../api/resources.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Select } from "../components/ui/select.js";
import { COPY } from "./onboarding/copy.js";
import { FlowHint, RepoTokenPicker, StatusRow } from "./onboarding/flow-ui.js";
import type { TreeBindingPlan } from "./onboarding/onboarding-flow.js";
import { kickoffErrorMessage } from "./onboarding/provision-tree.js";
import { ensureKickoffRepos, startTreeSetupKickoff } from "./onboarding/tree-kickoff.js";

/**
 * Per-tab marker set when the user kicks off a GitHub App install from this
 * card, so a return render shows "waiting for GitHub" + a deliberate re-mint.
 * Distinct key from the onboarding step so the two flows never cross. Same
 * install-popup discipline as the onboarding connect-code step (see
 * steps/step-connect-code.tsx) — kept as a small local copy on purpose so the
 * critical first-run path stays untouched.
 */
const INSTALL_ATTEMPT_KEY = "context-build:install-attempt";
const INSTALL_OWNER_HINT = {
  pre: "Only ",
  emphasis: "a GitHub org owner",
  post: " can install First Tree. If that's not you, GitHub will ask an owner to approve access first.",
};

/**
 * The team's single "build your Context Tree" action, on the Context tab.
 * Building is one chat-driven flow: connect code (if needed) → provision or
 * reuse the binding → start the `tree` agent chat that seeds/updates it. This
 * replaced the standalone `/build-tree` wizard page — there is one build home.
 *
 * When no code is connected yet, the connect + repo pick happens INLINE here
 * (install the GitHub App, then choose from the repos it grants) instead of
 * bouncing to Settings — the team already grants those repos, so sending the
 * user off to retype a URL was busywork.
 *
 * Admin-only (the caller gates on role + setup status). It never edits the tree
 * in the tab; it just launches the chat where the agent does, so it does not
 * breach the Context tab's read-only-perception boundary.
 */
export function ContextTreeBuildEntry({
  treeBindingPlan = "createBinding",
  detectedTreeUrl = null,
}: {
  treeBindingPlan?: TreeBindingPlan;
  detectedTreeUrl?: string | null;
}) {
  const { organizationId } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedAgentUuid, setSelectedAgentUuid] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "building">("idle");
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ["context-build", "managed-agents", organizationId],
    queryFn: listManagedAgents,
    enabled: !!organizationId,
  });
  const resourcesQuery = useQuery({
    queryKey: ["context-build", "resources", organizationId],
    queryFn: () => (organizationId ? listTeamResourcesForOrg(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  // Usable agents in THIS org, newest first (uuid v7 is time-ordered). A
  // suspended agent can't bind/run, so it must never be picked to seed a tree.
  const agents = useMemo<ManagedAgent[]>(
    () =>
      (agentsQuery.data ?? [])
        .filter((a) => a.type !== "human" && a.status === "active" && a.organizationId === organizationId)
        .sort((a, b) => b.uuid.localeCompare(a.uuid)),
    [agentsQuery.data, organizationId],
  );
  const repoUrls = useMemo<string[]>(
    () =>
      (resourcesQuery.data ?? [])
        .filter((r) => r.type === "repo" && r.defaultEnabled === "recommended")
        .map((r) => {
          const url = (r.payload as { url?: unknown }).url;
          return typeof url === "string" ? url : "";
        })
        .filter((u) => u.length > 0),
    [resourcesQuery.data],
  );
  const usesBoundTree = treeBindingPlan === "useBoundTree";

  const loading = agentsQuery.isLoading || resourcesQuery.isLoading;
  const chosenAgent: ManagedAgent | undefined = agents.find((a) => a.uuid === selectedAgentUuid) ?? agents[0];

  const handleBuild = async (sourceRepos: readonly string[]): Promise<void> => {
    if (!organizationId || !chosenAgent) return;
    setError(null);
    setPhase("building");
    try {
      // New-tree setup registers the chosen repos before Cloud one-click creates
      // the binding; a bound-tree recovery passes no repos and only re-sends the
      // idempotent tree kickoff.
      if (sourceRepos.length > 0) await ensureKickoffRepos(organizationId, sourceRepos);
      const chatId = await startTreeSetupKickoff({
        agent: chosenAgent,
        organizationId,
        sourceRepos,
        treeBindingPlan,
        detectedTreeUrl,
        queryClient,
        complete: true,
      });
      navigate(`/?c=${encodeURIComponent(chatId)}`);
    } catch (err) {
      setError(kickoffErrorMessage(err, "Couldn't start building your Context Tree. Try again."));
      setPhase("idle");
    }
  };

  if (loading) {
    return (
      <div className="text-label" style={{ color: "var(--fg-4)" }}>
        Loading…
      </div>
    );
  }

  // An agent is required to build, with or without code connected — so this check
  // comes first. It also guarantees the inline connect+pick below always has an
  // agent to hand the build to.
  if (agents.length === 0) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <span className="text-body" style={{ color: "var(--fg-2)" }}>
          Create an agent for your team first, then build your Context Tree.
        </span>
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => navigate("/onboarding")}>
            <span>Create an agent</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  // No repo resource yet (and not a bound-tree recovery) → connect the GitHub App
  // and pick a repo INLINE, then build. A bound-tree recovery skips this and
  // re-sends the kickoff for the existing binding (no repo pick needed).
  if (!usesBoundTree && repoUrls.length === 0) {
    return (
      <ConnectAndPickRepos
        organizationId={organizationId}
        agents={agents}
        chosenAgent={chosenAgent}
        onSelectAgent={setSelectedAgentUuid}
        building={phase === "building"}
        buildError={error}
        onBuild={(sourceRepos) => void handleBuild(sourceRepos)}
      />
    );
  }

  // Code already connected (or a bound-tree recovery): pick the builder agent and
  // build straight from the team's recommended repos.
  return (
    <BuildAgentControls
      agents={agents}
      chosenAgent={chosenAgent}
      onSelectAgent={setSelectedAgentUuid}
      building={phase === "building"}
      buildError={error}
      onBuild={() => void handleBuild(repoUrls)}
    />
  );
}

/**
 * Inline "connect your code" for the no-repo state: install the GitHub App (if
 * needed) in a popup, then pick from the repos the team's installation grants —
 * the same install + pick the onboarding connect-code step does, surfaced here
 * so the user never leaves the Context tab to wire up a repo.
 */
function ConnectAndPickRepos({
  organizationId,
  agents,
  chosenAgent,
  onSelectAgent,
  building,
  buildError,
  onBuild,
}: {
  organizationId: string | null;
  agents: ManagedAgent[];
  chosenAgent: ManagedAgent | undefined;
  onSelectAgent: (uuid: string | null) => void;
  building: boolean;
  buildError: string | null;
  onBuild: (sourceRepos: readonly string[]) => void;
}) {
  const [selectedRepoUrls, setSelectedRepoUrls] = useState<string[]>([]);
  const [grantCheckError, setGrantCheckError] = useState<string | null>(null);
  const [checkingGrant, setCheckingGrant] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [installError, setInstallError] = useState<"not_configured" | "not_admin" | "generic" | null>(null);
  const [attempted, setAttempted] = useState(
    () => typeof window !== "undefined" && !!window.sessionStorage.getItem(INSTALL_ATTEMPT_KEY),
  );

  // Poll for the installation until it appears: the popup installs on GitHub and
  // self-closes, and this card advances on its own once the row shows up.
  const installQuery = useQuery({
    queryKey: ["context-build", "installation", organizationId],
    queryFn: () => getGithubAppInstallation(organizationId ?? ""),
    enabled: !!organizationId,
    refetchInterval: (query) => (query.state.data ? false : 4000),
  });
  const installed = !!installQuery.data;

  useEffect(() => {
    if (installed && typeof window !== "undefined") window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
  }, [installed]);

  // The pickable repos come from the App installation's grant (server-minted
  // token), not the caller's personal repos — so only repos the agent can
  // actually reach show up.
  const reposQuery = useQuery({
    queryKey: ["context-build", "org-github-repos", organizationId],
    queryFn: () => listOrgGithubRepos(organizationId ?? ""),
    enabled: installed && !!organizationId,
  });
  const loadFailed = !!reposQuery.error;
  const hasPickableRepos = !reposQuery.error && (reposQuery.data?.length ?? 0) > 0;

  const handleConnect = async (): Promise<void> => {
    if (!organizationId) return;
    setInstallError(null);
    setRedirecting(true);
    // Open the popup synchronously inside the click gesture so the browser doesn't
    // treat the post-await open as a blocked popup; fill its location once the
    // install URL is minted. GitHub installs in that tab and lands it on
    // /onboarding/connected to self-close, while this card keeps polling above.
    const installTab = window.open("", "_blank");
    // Popup path lands the new tab on the self-closing /onboarding/connected
    // page; the popup-blocked full-redirect must return THIS tab to the card to
    // finish the inline pick. Both targets are on the server's post-install
    // allowlist (ALLOWED_POST_INSTALL_NEXT) — "/context" is the card's route, so
    // an off-allowlist value isn't silently bounced to /settings/github.
    const postInstallNext = installTab ? "/onboarding/connected" : "/context";
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
      if (err instanceof ApiError && err.status === 503) setInstallError("not_configured");
      else if (err instanceof ApiError && err.status === 403) setInstallError("not_admin");
      else setInstallError("generic");
    }
  };

  // Deliberate re-mint after a stuck install: a fresh URL overwrites the
  // oauth-state nonce cookie, so retry is an explicit action — never an auto
  // re-click while the first popup may still be mid-flow.
  const handleStartOver = (): void => {
    window.sessionStorage.removeItem(INSTALL_ATTEMPT_KEY);
    setAttempted(false);
    setInstallError(null);
  };

  const toggleRepo = (cloneUrl: string): void => {
    setGrantCheckError(null);
    setSelectedRepoUrls((prev) => (prev.includes(cloneUrl) ? prev.filter((u) => u !== cloneUrl) : [...prev, cloneUrl]));
  };

  const handleBuildSelectedRepos = async (): Promise<void> => {
    if (!organizationId || selectedRepoUrls.length === 0) return;
    setGrantCheckError(null);
    setCheckingGrant(true);
    try {
      // This is the write-path guard. The picker above is a UX cache; GitHub App
      // grants can change in another tab between render and Build, and
      // ensureKickoffRepos only validates resource creation, not current App
      // access. Re-read GitHub directly here and fail closed before writing a
      // stale team repo resource.
      const granted = await listOrgGithubRepos(organizationId);
      const grantedUrls = new Set(granted.map((repo) => repo.cloneUrl));
      const stillGranted = selectedRepoUrls.filter((url) => grantedUrls.has(url));

      if (stillGranted.length !== selectedRepoUrls.length) {
        setSelectedRepoUrls(stillGranted);
        void reposQuery.refetch();
        setGrantCheckError(
          stillGranted.length === 0
            ? "The selected source repo is no longer available to First Tree. Pick a repo and try again."
            : "Some selected source repos are no longer available to First Tree. Review the selection and try again.",
        );
        return;
      }

      onBuild(stillGranted);
    } catch {
      setGrantCheckError("Couldn't check your repositories with GitHub just now. Try again in a moment.");
    } finally {
      setCheckingGrant(false);
    }
  };

  // ── Not connected yet ──────────────────────────────────────────────────
  if (!installed) {
    // The two install errors that can't be fixed here (App not set up on this
    // server / caller isn't an org admin) share one message — building needs the
    // App and only an org owner can install it, so there's no inline way forward.
    if (installError === "not_configured" || installError === "not_admin") {
      return <FlowHint>{COPY.connectCode.cantConnectRecovery}</FlowHint>;
    }
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <div className="flex">
          <Button
            type="button"
            variant="cta"
            onClick={() => void handleConnect()}
            disabled={redirecting || attempted || !organizationId}
          >
            <Github className="h-4 w-4" />
            <span>{COPY.connectCode.cta}</span>
          </Button>
        </div>
        <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
          {INSTALL_OWNER_HINT.pre}
          <span className="font-medium" style={{ color: "var(--fg-3)" }}>
            {INSTALL_OWNER_HINT.emphasis}
          </span>
          {INSTALL_OWNER_HINT.post}
        </p>
        {installError === "generic" && (
          <FlowHint tone="error" role="alert">
            {COPY.errors.generic}
          </FlowHint>
        )}
        {attempted ? (
          <div className="flex items-center" style={{ gap: "var(--sp-2_5)", flexWrap: "wrap" }}>
            <StatusRow state="waiting" label={COPY.connectCode.waiting} />
            <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={handleStartOver}>
              {COPY.connectCode.restartInstall}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  // ── Connected — pick a repo, then build ────────────────────────────────
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
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
              {COPY.connectCode.loadFailedRecovery}
            </FlowHint>
            <div className="flex">
              <Button type="button" onClick={() => void reposQuery.refetch()}>
                {COPY.connectCode.loadFailedRetry}
              </Button>
            </div>
          </div>
        ) : (reposQuery.data?.length ?? 0) === 0 ? (
          <FlowHint>{COPY.connectCode.noReposRecovery}</FlowHint>
        ) : (
          <RepoTokenPicker
            repos={reposQuery.data ?? []}
            selected={selectedRepoUrls}
            onToggle={toggleRepo}
            onClear={() => {
              setGrantCheckError(null);
              setSelectedRepoUrls([]);
            }}
          />
        )}
      </div>
      {grantCheckError ? (
        <div className="text-label" style={{ color: "var(--state-error)" }} role="alert">
          {grantCheckError}
        </div>
      ) : null}
      {selectedRepoUrls.length > 0 ? (
        <BuildAgentControls
          agents={agents}
          chosenAgent={chosenAgent}
          onSelectAgent={onSelectAgent}
          building={building || checkingGrant}
          buildError={buildError}
          onBuild={() => void handleBuildSelectedRepos()}
        />
      ) : null}
    </div>
  );
}

/**
 * Agent selector (only shown when >1 agent) + the "Build your Context Tree" CTA.
 * Shared by the code-already-connected state and the just-picked-a-repo state.
 */
function BuildAgentControls({
  agents,
  chosenAgent,
  onSelectAgent,
  building,
  buildError,
  onBuild,
}: {
  agents: ManagedAgent[];
  chosenAgent: ManagedAgent | undefined;
  onSelectAgent: (uuid: string | null) => void;
  building: boolean;
  buildError: string | null;
  onBuild: () => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      {agents.length > 1 ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
          <span className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
            Which agent builds the tree?
          </span>
          <Select
            aria-label="Agent that builds the Context Tree"
            value={chosenAgent?.uuid ?? ""}
            onChange={(v) => onSelectAgent(v || null)}
            options={agents.map((a) => ({ value: a.uuid, label: agentLabel(a) }))}
          />
        </div>
      ) : null}
      {buildError ? (
        <div className="text-label" style={{ color: "var(--state-error)" }}>
          {buildError}
        </div>
      ) : null}
      <div className="flex">
        <Button type="button" variant="cta" disabled={building} onClick={() => onBuild()}>
          {building ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Building…</span>
            </>
          ) : (
            <>
              <span>Build your Context Tree</span>
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function agentLabel(agent: ManagedAgent): string {
  return agent.displayName.trim() || agent.name?.trim() || agent.uuid;
}
