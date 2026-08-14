import type { OrgGithubFeaturesOutput, SetupBlocker, TeamAgentCandidatesOutput } from "@first-tree/shared";
import { setupBlockerCodeSchema } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client.js";
import { getGithubFeaturesSetting } from "../../api/org-settings.js";
import { setupCapabilitiesQueryKey } from "../../api/setup-capabilities.js";
import { getTeamAgentCandidates, putTeamAgentAssignment } from "../../api/team-agent-settings.js";
import { useAuth } from "../../auth/auth-context.js";
import { Select } from "../../components/ui/select.js";
import { SettingRow } from "../../components/ui/setting-row.js";
import { setupBlockerCopy } from "./setup-blocker-copy.js";

export function GithubTaskAgentControls({
  loadSetting = getGithubFeaturesSetting,
  loadCandidates = getTeamAgentCandidates,
  assignTeamAgent = putTeamAgentAssignment,
}: {
  loadSetting?: (organizationId: string) => Promise<OrgGithubFeaturesOutput>;
  loadCandidates?: (organizationId: string) => Promise<TeamAgentCandidatesOutput>;
  assignTeamAgent?: (organizationId: string, agentUuid: string | null) => Promise<OrgGithubFeaturesOutput>;
}) {
  const { organizationId, role } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = role === "admin";
  const [selectedAgentUuid, setSelectedAgentUuid] = useState<string | null>(null);

  const settingQuery = useQuery({
    queryKey: ["team-agent", "setting", organizationId],
    queryFn: () =>
      organizationId ? loadSetting(organizationId) : Promise.reject(new Error("organization not loaded")),
    enabled: (role === "admin" || role === "member") && !!organizationId,
  });
  const candidatesQuery = useQuery({
    queryKey: ["team-agent", "candidates", organizationId],
    queryFn: () =>
      organizationId ? loadCandidates(organizationId) : Promise.reject(new Error("organization not loaded")),
    enabled: isAdmin && !!organizationId,
  });

  const projectedAgentUuid = settingQuery.data?.teamAgent.agentUuid ?? null;
  useEffect(() => {
    setSelectedAgentUuid(projectedAgentUuid);
  }, [projectedAgentUuid]);

  const assignmentMutation = useMutation({
    mutationFn: (agentUuid: string | null) => {
      if (!organizationId) throw new Error("organization not loaded");
      return assignTeamAgent(organizationId, agentUuid);
    },
    onSuccess: async (next) => {
      setSelectedAgentUuid(next.teamAgent.agentUuid);
      queryClient.setQueryData(["team-agent", "setting", organizationId], next);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["team-agent", "candidates", organizationId] }),
        queryClient.invalidateQueries({ queryKey: ["context-reviewer", "candidates", organizationId] }),
        queryClient.invalidateQueries({ queryKey: setupCapabilitiesQueryKey(organizationId) }),
      ]);
    },
  });

  if (!isAdmin) {
    const projectedAgent = settingQuery.data?.teamAgent.agent ?? null;
    return (
      <SettingRow
        data-github-task-agent-controls="read-only"
        icon={<Bot className="h-4 w-4" />}
        title="GitHub Task Agent"
        description={
          settingQuery.isLoading
            ? "Loading configured Agent…"
            : settingQuery.error
              ? "First Tree could not load the configured Agent."
              : projectedAgent
                ? `${projectedAgent.displayName} automatically handles Issue and pull request activity outside the Context Tree repository and posts final replies as the First Tree GitHub App.`
                : "Not configured. An admin can choose the Agent that automatically handles Issue and pull request activity outside the Context Tree repository and posts final replies as the First Tree GitHub App."
        }
      />
    );
  }

  const candidates = candidatesQuery.data?.items ?? [];
  const selectedCandidate = candidates.find((candidate) => candidate.uuid === selectedAgentUuid) ?? null;
  const selectedLabel =
    selectedCandidate?.displayName ??
    (selectedAgentUuid === projectedAgentUuid ? settingQuery.data?.teamAgent.agent?.displayName : null) ??
    null;
  const options = [
    {
      value: "",
      label: selectedAgentUuid ? "No GitHub Task Agent selected" : "Select an eligible Agent",
      disabled: !selectedAgentUuid,
    },
    ...candidates.map((candidate) => ({
      value: candidate.uuid,
      label: candidate.displayName,
      hint:
        candidate.runtime.health === "ready"
          ? candidate.name || "Runtime ready"
          : `${candidate.name ? `${candidate.name} · ` : ""}${runtimeLabel(candidate.runtime.health)}`,
    })),
  ];
  const blockers = candidatesQuery.data?.blockers ?? [];
  const appSlugMissing = blockers.some((item) => item.code === "github_app_slug_missing");
  const manageGithubInstallation = blockers.some(
    (item) => item.resolutionOwner === "admin" && item.actionKind === "manage_github_installation",
  );
  const error = settingQuery.error ?? candidatesQuery.error ?? assignmentMutation.error;
  const loading = settingQuery.isLoading || candidatesQuery.isLoading;
  const assignable = !loading && candidates.length > 0;

  return (
    <SettingRow
      data-github-task-agent-controls="admin"
      icon={<Bot className="h-4 w-4" />}
      title="GitHub Task Agent"
      description={
        selectedLabel
          ? `${selectedLabel} automatically handles Issue and pull request activity outside the Context Tree repository and posts final replies as the First Tree GitHub App.`
          : "Choose the Agent that automatically handles Issue and pull request activity outside the Context Tree repository and posts final replies as the First Tree GitHub App."
      }
      control={
        loading ? (
          <span className="text-label" style={{ color: "var(--fg-3)" }}>
            Loading eligible Agents…
          </span>
        ) : assignable ? (
          // The picker keeps a readable minimum instead of stretching the full
          // page width — it is one control in a column of controls, not a form.
          <div style={{ minWidth: "var(--sp-45)" }}>
            <Select
              aria-label="GitHub Task Agent"
              value={selectedAgentUuid ?? ""}
              onChange={(agentUuid) => {
                const next = agentUuid || null;
                if (next === selectedAgentUuid) return;
                assignmentMutation.mutate(next);
              }}
              disabled={assignmentMutation.isPending}
              options={options}
              placeholder="Select an eligible Agent"
              searchable={candidates.length > 6}
            />
          </div>
        ) : null
      }
    >
      {!loading && !assignable ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          {blockerText(blockers)}
          {manageGithubInstallation ? (
            <>
              {" "}
              <Link
                to="/settings/integrations/github#connection"
                className="font-medium"
                style={{ color: "var(--fg-2)" }}
              >
                Review connection
              </Link>
            </>
          ) : !appSlugMissing ? (
            <>
              {" "}
              <Link to="/team" className="font-medium" style={{ color: "var(--fg-2)" }}>
                Manage Team Agents
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      {assignable ? (
        <div className="text-caption" style={{ color: "var(--fg-4)" }}>
          Context Tree activity uses Context Reviewer. These roles must use different Agents.
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
          {teamAgentMutationError(error)}
        </div>
      ) : null}
    </SettingRow>
  );
}

function blockerText(blockers: SetupBlocker[]): string {
  const details = [...new Set(blockers.map((item) => setupBlockerCopy(item.code)))];
  return details.length > 0 ? details.join(" · ") : "No eligible organization-visible managed Agent is available.";
}

function teamAgentMutationError(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    const code = setupBlockerCodeSchema.safeParse(error.code);
    if (code.success) return setupBlockerCopy(code.data);
  }
  return error instanceof Error ? error.message : "Failed to update GitHub Task Agent";
}

function runtimeLabel(health: "not_observed" | "pending_verification" | "ready" | "degraded" | "unavailable"): string {
  switch (health) {
    case "not_observed":
      return "Runtime not observed";
    case "pending_verification":
      return "Runtime verification pending";
    case "ready":
      return "Runtime ready";
    case "degraded":
      return "Runtime currently unavailable";
    case "unavailable":
      return "Runtime unavailable";
  }
}
