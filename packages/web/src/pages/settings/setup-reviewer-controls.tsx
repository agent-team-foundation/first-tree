import type {
  ContextReviewerCandidatesOutput,
  OrgContextTreeFeaturesOutput,
  SetupActionKind,
  SetupAutomaticReview,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import {
  getContextReviewerCandidates,
  putContextReviewerAssignment,
  putContextReviewerEnablement,
} from "../../api/context-reviewer-settings.js";
import { setupCapabilitiesQueryKey } from "../../api/setup-capabilities.js";
import { useAuth } from "../../auth/auth-context.js";
import { Select } from "../../components/ui/select.js";
import { Switch } from "../../components/ui/switch.js";

export function SetupReviewerControls({
  review,
  loadCandidates = getContextReviewerCandidates,
  assignReviewer = putContextReviewerAssignment,
  setReviewerEnabled = putContextReviewerEnablement,
  refreshFacts,
}: {
  review: SetupAutomaticReview;
  loadCandidates?: (organizationId: string) => Promise<ContextReviewerCandidatesOutput>;
  assignReviewer?: (organizationId: string, agentUuid: string | null) => Promise<OrgContextTreeFeaturesOutput>;
  setReviewerEnabled?: (organizationId: string, enabled: boolean) => Promise<OrgContextTreeFeaturesOutput>;
  refreshFacts?: (organizationId: string) => Promise<void>;
}) {
  const { organizationId, role } = useAuth();
  const queryClient = useQueryClient();
  const switchLabelId = useId();
  const isAdmin = role === "admin";
  const projectedAgentUuid = review.reviewerAgent?.uuid ?? null;
  const projectedEnabled = review.adoption === "enabled";
  const [selectedAgentUuid, setSelectedAgentUuid] = useState(projectedAgentUuid);
  const [enabled, setEnabled] = useState(projectedEnabled);

  useEffect(() => {
    setSelectedAgentUuid(projectedAgentUuid);
    setEnabled(projectedEnabled);
  }, [projectedAgentUuid, projectedEnabled]);

  const candidatesQuery = useQuery({
    queryKey: ["context-reviewer", "candidates", organizationId],
    queryFn: () =>
      organizationId ? loadCandidates(organizationId) : Promise.reject(new Error("organization not loaded")),
    enabled: isAdmin && !!organizationId,
  });

  const refreshProjectedFacts = async () => {
    if (organizationId && refreshFacts) {
      await refreshFacts(organizationId);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: setupCapabilitiesQueryKey(organizationId) });
  };

  const assignmentMutation = useMutation({
    mutationFn: (agentUuid: string | null) => {
      if (!organizationId) throw new Error("organization not loaded");
      return assignReviewer(organizationId, agentUuid);
    },
    onSuccess: async (next) => {
      setSelectedAgentUuid(next.contextReviewer.agentUuid);
      setEnabled(next.contextReviewer.enabled);
      await refreshProjectedFacts();
    },
  });

  const enablementMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      if (!organizationId) throw new Error("organization not loaded");
      return setReviewerEnabled(organizationId, enabled);
    },
    onSuccess: async (next) => {
      setEnabled(next.contextReviewer.enabled);
      await refreshProjectedFacts();
    },
  });

  const candidates = candidatesQuery.data?.items ?? [];
  const selectedCandidate = candidates.find((candidate) => candidate.uuid === selectedAgentUuid) ?? null;
  const selectedLabel =
    selectedCandidate?.displayName ??
    (selectedAgentUuid === projectedAgentUuid ? review.reviewerAgent?.displayName : null) ??
    null;
  const saving = assignmentMutation.isPending || enablementMutation.isPending;
  const options = [
    {
      value: "",
      label: selectedAgentUuid ? "No Reviewer selected" : "Select an eligible managed Agent",
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
  const recovery = reviewerRecovery(review);

  if (!isAdmin) return null;

  return (
    <div
      data-setup-owner-controls="automatic-review"
      className="flex flex-col"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-4)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        background: "var(--bg-sunken)",
      }}
    >
      <div className="flex items-center justify-between" style={{ gap: "var(--sp-3)" }}>
        <div className="min-w-0">
          <span id={switchLabelId} className="text-body font-medium" style={{ color: "var(--fg)" }}>
            Automatic review
          </span>
          <div className="text-label" style={{ marginTop: "var(--sp-0_5)", color: "var(--fg-3)" }}>
            {selectedLabel
              ? `Reviewer · ${selectedLabel}${enabled ? "" : " · selection retained while off"}`
              : "Choose an existing eligible Team Agent. Setup never creates one."}
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => enablementMutation.mutate(next)}
          disabled={saving || (!enabled && !selectedAgentUuid)}
          aria-labelledby={switchLabelId}
        />
      </div>

      {candidatesQuery.isLoading ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          Loading eligible Agents…
        </div>
      ) : candidatesQuery.error ? (
        <div role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
          {candidatesQuery.error instanceof Error
            ? candidatesQuery.error.message
            : "Failed to load eligible Context Review Agents"}
        </div>
      ) : candidates.length === 0 ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          No eligible organization-visible managed Agent is available.{" "}
          <Link to="/team" className="font-medium" style={{ color: "var(--fg-2)" }}>
            Manage Team Agents
          </Link>
          , then retry.
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <span className="text-label font-medium" style={{ color: "var(--fg)" }}>
            Reviewer Agent
          </span>
          <Select
            aria-label="Automatic review Agent"
            value={selectedAgentUuid ?? ""}
            onChange={(agentUuid) => {
              const next = agentUuid || null;
              if (next === selectedAgentUuid) return;
              assignmentMutation.mutate(next);
            }}
            disabled={saving}
            options={options}
            placeholder="Select an eligible managed Agent"
            searchable={candidates.length > 6}
          />
          <div className="text-caption" style={{ color: "var(--fg-4)" }}>
            Changing the assignment turns Automatic Review off. Re-enable it separately after reviewing current provider
            readiness.
          </div>
        </div>
      )}

      {candidatesQuery.data?.blockers.length ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          Candidate availability is limited by current Team Agent ownership or runtime support.
        </div>
      ) : null}
      {recovery ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          Provider or Agent recovery is still required.{" "}
          <Link to={recovery.to} className="font-medium" style={{ color: "var(--fg-2)" }}>
            {recovery.label}
          </Link>
        </div>
      ) : null}
      {assignmentMutation.error instanceof Error || enablementMutation.error instanceof Error ? (
        <div role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
          {(assignmentMutation.error ?? enablementMutation.error)?.message}
        </div>
      ) : null}
    </div>
  );
}

function reviewerRecovery(review: SetupAutomaticReview): { label: string; to: string } | null {
  const actionKind = review.blockers.find(
    (blocker) => blocker.resolutionOwner === "admin" && blocker.actionKind,
  )?.actionKind;
  if (!actionKind) return null;

  const recovery: Partial<Record<SetupActionKind, { label: string; to: string }>> = {
    connect_github: { label: "Connect GitHub", to: "/settings/integrations/github" },
    manage_github_installation: { label: "Manage GitHub", to: "/settings/integrations/github" },
    connect_gitlab: { label: "Connect GitLab", to: "/settings/integrations/gitlab" },
    configure_gitlab_webhook: { label: "Configure GitLab", to: "/settings/integrations/gitlab" },
    open_agent_owner_flow: { label: "Manage Team Agents", to: "/team" },
  };
  return recovery[actionKind] ?? null;
}

function runtimeLabel(health: SetupAutomaticReview["health"]): string {
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
