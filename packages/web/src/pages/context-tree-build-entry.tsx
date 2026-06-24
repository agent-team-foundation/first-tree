import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listManagedAgents, type ManagedAgent } from "../api/agents.js";
import { listTeamResourcesForOrg } from "../api/resources.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Select } from "../components/ui/select.js";
import type { TreeBindingPlan } from "./onboarding/onboarding-flow.js";
import { kickoffErrorMessage } from "./onboarding/provision-tree.js";
import { ensureKickoffRepos, startTreeSetupKickoff } from "./onboarding/tree-kickoff.js";

/**
 * The team's single "build your Context Tree" action, on the Context tab.
 * Building is one chat-driven flow: connect code (if needed) → provision or
 * reuse the binding → start the `tree` agent chat that seeds/updates it. This
 * replaced the standalone `/build-tree` wizard page — there is one build home.
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

  const handleBuild = async (): Promise<void> => {
    if (!organizationId || !chosenAgent) return;
    setError(null);
    setPhase("building");
    try {
      // New-tree setup registers selected repos before Cloud one-click creates
      // the binding; recovery states with an existing binding only need to
      // resend the idempotent tree kickoff.
      if (repoUrls.length > 0) await ensureKickoffRepos(organizationId, repoUrls);
      const chatId = await startTreeSetupKickoff({
        agent: chosenAgent,
        organizationId,
        sourceRepos: repoUrls,
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

  // No code connected and no tree binding → nothing to seed a new tree from.
  // Recovery with an existing binding can still launch the setup chat so the
  // agent reads the bound tree and decides seed vs. incremental update there.
  if (!usesBoundTree && repoUrls.length === 0) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <span className="text-body" style={{ color: "var(--fg-2)" }}>
          Connect a code repository first — your agent builds the tree from your code.
        </span>
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => navigate("/settings/resources")}>
            <span>Connect your code</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

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
            onChange={(v) => setSelectedAgentUuid(v || null)}
            options={agents.map((a) => ({ value: a.uuid, label: agentLabel(a) }))}
          />
        </div>
      ) : null}
      {error ? (
        <div className="text-label" style={{ color: "var(--state-error)" }}>
          {error}
        </div>
      ) : null}
      <div className="flex">
        <Button type="button" variant="cta" disabled={phase === "building"} onClick={() => void handleBuild()}>
          {phase === "building" ? (
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
