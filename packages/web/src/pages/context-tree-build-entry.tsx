import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Github, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { listManagedAgents, type ManagedAgent } from "../api/agents.js";
import { listOrgGithubRepos } from "../api/github.js";
import { getGithubAppInstallation } from "../api/github-app.js";
import { listTeamResourcesForOrg } from "../api/resources.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Select } from "../components/ui/select.js";
import { COPY } from "./onboarding/copy.js";
import { FlowHint, RepoTokenPicker } from "./onboarding/flow-ui.js";
import type { TreeBindingPlan } from "./onboarding/onboarding-flow.js";
import { startChatErrorMessage } from "./onboarding/provision-tree.js";
import { ensureStartChatRepos, startTreeSetupChat } from "./onboarding/tree-setup-chat.js";

/**
 * The team's single "build your Context Tree" action, on the Context tab.
 * Building is one chat-driven flow: connect code (if needed) → start the tree
 * setup chat, where the agent (first-tree-seed) sets the tree up from its actual
 * state — creating + binding it from zero, or filling a bound-but-empty tree. No
 * server-side provisioning. This replaced the standalone `/build-tree` wizard
 * page — there is one build home.
 *
 * When GitHub isn't connected yet, this card links to Settings → GitHub — the
 * single place that installs the App and connects it to the team (binding is an
 * explicit connect action that only lives there). Once connected, the user
 * returns here to pick a repo and build; the card advances on its own via the
 * installed poll below.
 *
 * Admin-only (the caller gates on role + setup status). It never edits the tree
 * in the tab; it just launches the chat where the agent does, so it does not
 * breach the Context tab's read-only-perception boundary.
 */
export function ContextTreeBuildEntry({
  treeBindingPlan = "agentSeed",
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
      // New-tree setup registers the chosen repos, then the agent sets the tree
      // up (create + bind + seed) in the chat; a bound-tree recovery passes no
      // repos and only re-sends the idempotent tree setup chat.
      if (sourceRepos.length > 0) await ensureStartChatRepos(organizationId, sourceRepos);
      const chatId = await startTreeSetupChat({
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
      setError(startChatErrorMessage(err, "Couldn't start building your Context Tree. Try again."));
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
  // re-sends the tree setup message for the existing binding (no repo pick needed).
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
 * The no-repo state on the Context tab. When GitHub isn't connected yet it links
 * to Settings → GitHub (the one place that installs + connects the App); once
 * connected it picks from the repos the team's installation grants and builds.
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

  // Poll for the team's installation: connecting happens on Settings → GitHub,
  // so once the user connects there and returns, this card advances on its own
  // to the repo pick the moment the bound installation shows up.
  const installQuery = useQuery({
    queryKey: ["context-build", "installation", organizationId],
    queryFn: () => getGithubAppInstallation(organizationId ?? ""),
    enabled: !!organizationId,
    refetchInterval: (query) => (query.state.data ? false : 4000),
  });
  const installed = !!installQuery.data;

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
      // ensureStartChatRepos only validates resource creation, not current App
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

  // ── GitHub not connected yet → point at Settings ───────────────────────
  // Install + connect both live on Settings → GitHub (binding an installation to
  // the team is an explicit connect action that only exists there). Link out
  // with `from=context` so Settings can offer a "back to building" return once
  // connected; this card then advances on its own via the installed poll above.
  if (!installed) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <div className="flex">
          <Button asChild variant="cta">
            <Link to="/settings/github?from=context">
              <Github className="h-4 w-4" aria-hidden />
              <span>{COPY.connectCode.connectInSettings}</span>
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
        </div>
        <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
          {COPY.connectCode.connectInSettingsHint}
        </p>
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
