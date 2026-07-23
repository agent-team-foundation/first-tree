import {
  type ContextTreeProvider,
  deriveRepoLocalPath,
  resolveContextTreeProvider,
  resolveGitLabRepositoryWebIdentity,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listAllAgents, type ManagedAgent } from "../api/agents.js";
import { gitlabConnectionsQueryKey, listGitlabConnectionsAt } from "../api/gitlab-connections.js";
import {
  getContextTreeFeaturesSetting,
  getContextTreeSetting,
  getRawContextTreeSetting,
  putContextTreeFeaturesSetting,
  putContextTreeSetting,
} from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Section } from "../components/ui/section.js";
import { Select } from "../components/ui/select.js";
import { SettingsField, SettingsSaveButton } from "../components/ui/settings-field.js";
import { Switch } from "../components/ui/switch.js";
import { titleWithSemantics, useJustSaved } from "./agent-detail/save-semantics.js";
import { fetchAllAgents } from "./team/index.js";

/**
 * Context Tree block on Settings → Repositories. It owns the per-org repo /
 * branch binding plus the separate Context Reviewer feature.
 *
 * This page is config, not status — the live "is the tree fresh / who reads &
 * writes it" view is the top-level Context tab, and building a team's first tree
 * also lives there. So this page never shows a build CTA: a team that already
 * has a tree must not be told to "build" one (the old always-on
 * "Connect your code & build" button was that bug).
 *
 * Members may read the binding (the `context_tree` namespace is
 * `readPolicy: "member"`); only admins edit it or configure Context Reviewer.
 */
export function ContextTreeSettingsPanel() {
  const { organizationId, role } = useAuth();
  const isAdmin = role === "admin";
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree", isAdmin ? "raw" : "safe"],
    queryFn: () =>
      organizationId
        ? isAdmin
          ? getRawContextTreeSetting(organizationId)
          : getContextTreeSetting(organizationId)
        : Promise.reject(new Error("no org")),
    enabled: !!organizationId,
  });

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const hasBinding = !!settingQuery.data?.repo;
  const provider =
    settingQuery.data?.provider ?? resolveContextTreeProvider({ repo: settingQuery.data?.repo ?? null }).provider;

  useEffect(() => {
    if (!settingQuery.data) return;
    setRepo(settingQuery.data.repo ?? "");
    setBranch(settingQuery.data.branch ?? "main");
  }, [settingQuery.data]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("organization not loaded");
      return putContextTreeSetting(organizationId, {
        repo: repo.trim() ? repo.trim() : null,
        branch: branch.trim() ? branch.trim() : null,
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["org-setting", organizationId, "context_tree", "raw"], next);
      queryClient.setQueryData(["org-setting", organizationId, "context_tree", "safe"], next);
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Read-only members have no Save affordance, but Enter inside a field would
    // still submit; the server 403s a member PUT regardless, but don't fire it.
    if (!isAdmin) return;
    mutation.mutate();
  };

  return (
    <Section title="Context Tree" description="The repository that stores your team's shared context.">
      <div>
        <div style={{ padding: "var(--sp-3) 0", borderBottom: "var(--hairline) solid var(--border-faint)" }}>
          {settingQuery.isLoading ? (
            <div className="text-body" style={{ color: "var(--fg-3)" }}>
              Loading…
            </div>
          ) : settingQuery.error ? (
            <div className="text-body" style={{ color: "var(--state-error)" }}>
              {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load setting"}
            </div>
          ) : hasBinding ? (
            <BoundTree
              repo={settingQuery.data?.repo ?? ""}
              branch={settingQuery.data?.branch ?? "main"}
              provider={provider}
              isAdmin={isAdmin}
              editing={editing}
              onToggleEdit={() => setEditing((v) => !v)}
              onViewContext={() => navigate("/context")}
            />
          ) : (
            <NoTree
              isAdmin={isAdmin}
              editing={editing}
              onToggleEdit={() => setEditing((v) => !v)}
              onGoToContext={() => navigate("/context")}
            />
          )}

          {hasBinding && provider === "gitlab" ? (
            <GitlabAutomationHealth repo={settingQuery.data?.repo ?? ""} organizationId={organizationId} />
          ) : null}

          {/* Manual binding form — admin only, on demand. Edits an existing
              binding, or points at a tree repo the team already has elsewhere.
              Building a NEW tree is the Context tab's job, not a form here. */}
          {isAdmin && editing ? (
            <form onSubmit={handleSubmit} style={{ marginTop: "var(--sp-4)" }}>
              <SettingsField
                label="Repo URL"
                hint="HTTPS URL of the Context Tree git repository for this team."
                value={repo}
                onChange={setRepo}
                mono
                placeholder="https://github.com/your-org/first-tree-context"
              />
              <SettingsField
                label="Branch"
                hint="Branch your agents check out on startup."
                value={branch}
                onChange={setBranch}
                mono
                placeholder="main"
                saved={saved}
                rightSlot={<SettingsSaveButton pending={mutation.isPending} disabled={!settingQuery.data} />}
              />
              {mutation.error instanceof Error && (
                <div className="text-body" style={{ color: "var(--state-error)" }}>
                  {mutation.error.message}
                </div>
              )}
            </form>
          ) : null}
        </div>
        <ContextReviewerSection hasBinding={hasBinding} isAdmin={isAdmin} provider={provider} />
      </div>
    </Section>
  );
}

/** Bound-tree summary: which repo / branch this team's tree lives in, a link into
 *  the live Context tab, and (admin) an Edit toggle for the manual binding form. */
function BoundTree({
  repo,
  branch,
  provider,
  isAdmin,
  editing,
  onToggleEdit,
  onViewContext,
}: {
  repo: string;
  branch: string;
  provider: ContextTreeProvider | null;
  isAdmin: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onViewContext: () => void;
}) {
  const name = deriveRepoLocalPath(repo) || repo;
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <div className="flex flex-col sm:flex-row sm:items-start" style={{ gap: "var(--sp-3)" }}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline" style={{ gap: "var(--sp-3)" }}>
            <span className="text-body font-medium truncate" style={{ color: "var(--fg)" }} title={name}>
              {name}
            </span>
            <span className="text-label shrink-0" style={{ color: "var(--fg-3)" }}>
              {branch} branch
            </span>
            {provider ? (
              <span className="text-label shrink-0" style={{ color: "var(--fg-3)", textTransform: "capitalize" }}>
                {provider}
              </span>
            ) : (
              <span className="text-label shrink-0" style={{ color: "var(--warning)" }}>
                Provider unresolved
              </span>
            )}
          </div>
          <div
            className="text-caption"
            style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)", wordBreak: "break-all" }}
          >
            {repo}
          </div>
        </div>
        <div className="flex shrink-0 items-center" style={{ gap: "var(--sp-4)" }}>
          {isAdmin ? (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              style={{ color: "var(--fg-3)" }}
              onClick={onToggleEdit}
            >
              {editing ? "Close" : "Edit"}
            </Button>
          ) : null}
          <Button type="button" variant="link" className="h-auto p-0" onClick={onViewContext}>
            <span>Open Context</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function GitlabAutomationHealth({ repo, organizationId }: { repo: string; organizationId: string | null }) {
  const connections = useQuery({
    queryKey: gitlabConnectionsQueryKey(organizationId),
    queryFn: () => (organizationId ? listGitlabConnectionsAt(organizationId) : Promise.resolve([])),
    enabled: !!organizationId,
  });
  if (connections.isLoading) {
    return <div className="text-label text-muted-foreground mt-2">Loading GitLab Webhook health…</div>;
  }
  if (connections.error) {
    return <div className="text-label text-destructive mt-2">GitLab Webhook health unavailable.</div>;
  }
  const connection = connections.data?.[0] ?? null;
  const originMatches =
    connection !== null &&
    resolveGitLabRepositoryWebIdentity(repo, connection.instanceOrigin)?.originMatchesConnection === true;
  const status = !connection
    ? "Degraded · no GitLab Webhook connection"
    : !originMatches
      ? `Degraded · Webhook origin ${connection.instanceOrigin} does not match the repository origin`
      : connection.endpointSeen
        ? "Ready · inbound Webhook observed"
        : "Waiting · configure the project Webhook";
  return (
    <div
      className="text-label"
      style={{
        color: originMatches && connection?.endpointSeen ? "var(--success)" : "var(--fg-3)",
        marginTop: "var(--sp-2)",
      }}
    >
      Automatic MR review: {status}
      {connection?.health.lastValidInboundAt ? ` · last valid inbound ${connection.health.lastValidInboundAt}` : ""}
    </div>
  );
}

/** No tree bound yet. Admin: building lives on the Context tab (one build home),
 *  with a quiet "bind an existing repo" escape for teams that already have one.
 *  Member: nothing to do but wait on an admin. */
function NoTree({
  isAdmin,
  editing,
  onToggleEdit,
  onGoToContext,
}: {
  isAdmin: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onGoToContext: () => void;
}) {
  if (!isAdmin) {
    return (
      <div className="text-body" style={{ color: "var(--fg-3)" }}>
        Your team doesn't have a Context Tree yet. Ask an admin to set one up.
      </div>
    );
  }
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <span className="text-body" style={{ color: "var(--fg-2)" }}>
        Your team doesn't have a Context Tree yet.
      </span>
      <div>
        <Button type="button" variant="link" className="h-auto p-0" onClick={onGoToContext}>
          <span>Set one up on the Context page</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
      <div>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          style={{ color: "var(--fg-3)" }}
          onClick={onToggleEdit}
        >
          {editing ? "Close" : "Already have a tree repo? Bind it manually"}
        </Button>
      </div>
    </div>
  );
}

/** Context Reviewer: assign an agent to auto-review Context Tree PRs. Meaningful
 *  only once a tree is bound. It is a row inside the Context Tree section, not
 *  a peer heading: the binding and reviewer are one visible chapter but remain
 *  separate settings models.
 *
 *  This is an immediate-save config block (no page-level Save), mirroring the
 *  Agent Detail Switch rows: flipping the Switch or picking an agent persists at
 *  once and flashes "Saved" next to the title. The one wrinkle is the backend
 *  contract — `enabled=true` is rejected without a valid `agentUuid` — so turning
 *  the Switch ON cannot blindly PATCH `enabled`. Instead it opens a local "setup"
 *  on-state (`setupOpen`) that reveals the agent selector; the enable actually
 *  persists only once an agent is chosen. State is driven from the server query,
 *  not a local mirror, and every save passes an explicit payload so an instant
 *  handler never reads stale local state. */
function ContextReviewerSection({
  hasBinding,
  isAdmin,
  provider,
}: {
  hasBinding: boolean;
  isAdmin: boolean;
  provider: ContextTreeProvider | null;
}) {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useJustSaved();
  const toggleLabelId = useId();

  const featuresQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree_features"],
    queryFn: () =>
      organizationId ? getContextTreeFeaturesSetting(organizationId) : Promise.reject(new Error("no org")),
    enabled: !!organizationId,
  });

  const serverEnabled = featuresQuery.data?.contextReviewer.enabled ?? false;
  const serverAgentUuid = featuresQuery.data?.contextReviewer.agentUuid ?? null;

  // Pre-persistence on-state: the Switch is flipped on but `enabled` is not yet
  // saved (no agent picked). Once enabled persists, `serverEnabled` carries the
  // on-state and this resets. Off + already-enabled persists `enabled=false`;
  // off while only `setupOpen` just abandons the un-saved setup.
  const [setupOpen, setSetupOpen] = useState(false);
  const switchOn = serverEnabled || setupOpen;

  const managedAgentsQuery = useQuery({
    queryKey: ["context-reviewer", "org-agents", organizationId],
    queryFn: () => fetchAllAgents((params) => listAllAgents(params)),
    enabled: isAdmin && !!organizationId && switchOn,
  });

  const reviewerCandidates = useMemo(() => {
    return (managedAgentsQuery.data ?? [])
      .filter((agent) => agent.organizationId === organizationId && agent.type !== "human" && agent.status === "active")
      .sort((a, b) => {
        const byLabel = agentLabel(a).localeCompare(agentLabel(b), undefined, { sensitivity: "base" });
        return byLabel === 0 ? a.uuid.localeCompare(b.uuid) : byLabel;
      });
  }, [managedAgentsQuery.data, organizationId]);

  const agentsLoading = managedAgentsQuery.isLoading;
  const selectedIsCandidate = reviewerCandidates.some((agent) => agent.uuid === serverAgentUuid);
  // Enabled, but the saved reviewer is no longer an active agent this admin can
  // see: keep the Switch on, warn, and let them re-pick or turn it off.
  const reviewerMissing = serverEnabled && !selectedIsCandidate && !agentsLoading;
  // Switch is on for setup but no agent chosen yet — prompt for the pick that
  // actually enables the feature.
  const awaitingAgent = setupOpen && !serverEnabled && !agentsLoading && reviewerCandidates.length > 0;

  const featuresMutation = useMutation({
    mutationFn: (next: { enabled: boolean; agentUuid: string | null }) => {
      if (!organizationId) throw new Error("organization not loaded");
      return putContextTreeFeaturesSetting(organizationId, { contextReviewer: next });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["org-setting", organizationId, "context_tree_features"], next);
      setSetupOpen(false);
      markSaved();
    },
  });
  const saving = featuresMutation.isPending;
  const reviewLabel = provider === "gitlab" ? "Automatic MR review" : "Automatic PR review";
  const reviewActionLabel = provider === "gitlab" ? "automatic MR review" : "automatic PR review";

  const handleToggle = (next: boolean) => {
    if (next) {
      setSetupOpen(true);
      return;
    }
    setSetupOpen(false);
    if (serverEnabled) featuresMutation.mutate({ enabled: false, agentUuid: null });
  };

  const handleSelectAgent = (uuid: string) => {
    if (!uuid) return;
    featuresMutation.mutate({ enabled: true, agentUuid: uuid });
  };

  const selectedReviewer = reviewerCandidates.find((agent) => agent.uuid === serverAgentUuid) ?? null;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)", padding: "var(--sp-3) 0" }}>
      {!hasBinding ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Available once your team has a Context Tree.
        </div>
      ) : featuresQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      ) : featuresQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          {featuresQuery.error instanceof Error ? featuresQuery.error.message : "Failed to load feature settings"}
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          {isAdmin ? (
            <div className="flex items-center justify-between" style={{ gap: "var(--sp-3)" }}>
              <div className="min-w-0">
                <span id={toggleLabelId} className="text-body font-medium" style={{ color: "var(--fg)" }}>
                  {titleWithSemantics(reviewLabel, justSaved)}
                </span>
                {serverEnabled && selectedReviewer ? (
                  <button
                    type="button"
                    className="block rounded-[var(--radius-input)] border-0 bg-transparent p-0 text-left text-label focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}
                    aria-expanded={setupOpen}
                    onClick={() => setSetupOpen((open) => !open)}
                  >
                    Reviewer agent · {agentLabel(selectedReviewer)}
                  </button>
                ) : null}
              </div>
              <Switch
                checked={switchOn}
                onCheckedChange={handleToggle}
                disabled={saving}
                aria-labelledby={toggleLabelId}
              />
            </div>
          ) : (
            <ContextReviewerReadOnly
              reviewLabel={reviewLabel}
              contextReviewer={
                featuresQuery.data?.contextReviewer ?? { enabled: false, agentUuid: null, reviewerAgent: null }
              }
            />
          )}

          {isAdmin && (setupOpen || reviewerMissing) ? (
            <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <span className="text-label font-medium" style={{ color: "var(--fg)" }}>
                Reviewer agent
              </span>
              {agentsLoading ? (
                <div className="text-body" style={{ color: "var(--fg-3)" }}>
                  Loading agents…
                </div>
              ) : reviewerCandidates.length === 0 ? (
                <div className="text-body" style={{ color: "var(--fg-3)" }}>
                  No active non-human agents are available.
                </div>
              ) : (
                <Select
                  aria-label={`${reviewLabel} agent`}
                  value={serverEnabled && selectedIsCandidate ? (serverAgentUuid ?? "") : ""}
                  onChange={handleSelectAgent}
                  disabled={saving}
                  options={[
                    { value: "", label: "Select an agent", disabled: true },
                    ...reviewerCandidates.map((agent) => ({
                      value: agent.uuid,
                      label: agentLabel(agent),
                      hint: agent.name || undefined,
                    })),
                  ]}
                  placeholder="Select an agent"
                  searchable={reviewerCandidates.length > 6}
                />
              )}
              {awaitingAgent ? (
                <div className="text-label" style={{ color: "var(--fg-3)" }}>
                  Select an agent to enable {reviewActionLabel}.
                </div>
              ) : null}
              {reviewerMissing && reviewerCandidates.length > 0 ? (
                <div className="text-label" style={{ color: "var(--fg-3)" }}>
                  Current reviewer is not an active organization agent. Choose another agent, or turn{" "}
                  {reviewActionLabel} off.
                </div>
              ) : null}
              {managedAgentsQuery.error ? (
                <div className="text-body" style={{ color: "var(--state-error)" }}>
                  {managedAgentsQuery.error instanceof Error
                    ? managedAgentsQuery.error.message
                    : "Failed to load agents"}
                </div>
              ) : null}
            </div>
          ) : null}

          {serverEnabled ? (
            <div className="text-label" style={{ color: "var(--fg-3)" }}>
              Changing the reviewer does not move open {provider === "gitlab" ? "MRs" : "PRs"} immediately. Re-run the
              Context Tree write task for an existing {provider === "gitlab" ? "MR" : "PR"} to hand it over in the same
              Chat.
            </div>
          ) : null}

          {featuresMutation.error instanceof Error ? (
            <div className="text-body" style={{ color: "var(--state-error)" }}>
              {featuresMutation.error.message}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function agentLabel(agent: ManagedAgent): string {
  return agent.displayName.trim() || agent.name?.trim() || agent.uuid;
}

function ContextReviewerReadOnly({
  contextReviewer,
  reviewLabel,
}: {
  reviewLabel: string;
  contextReviewer: {
    enabled: boolean;
    agentUuid: string | null;
    reviewerAgent?: { uuid: string; name: string | null; displayName: string } | null;
  };
}) {
  const reviewerLabel = contextReviewer.reviewerAgent
    ? contextReviewer.reviewerAgent.displayName.trim() ||
      contextReviewer.reviewerAgent.name?.trim() ||
      contextReviewer.reviewerAgent.uuid
    : null;

  return (
    <div className="flex items-center justify-between" style={{ gap: "var(--sp-3)" }}>
      <div className="min-w-0">
        <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {reviewLabel}
        </span>
        {contextReviewer.enabled ? (
          <div className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
            {reviewerLabel ? `Reviewer agent · ${reviewerLabel}` : "Configured reviewer is no longer available."}
          </div>
        ) : null}
      </div>
      <span className="text-label" style={{ color: contextReviewer.enabled ? "var(--success)" : "var(--fg-3)" }}>
        {contextReviewer.enabled ? "On" : "Off"}
      </span>
    </div>
  );
}
