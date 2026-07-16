import type { OrgContextTreeFeaturesInput } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listAllAgents, type ManagedAgent } from "../api/agents.js";
import { getGithubAppInstallation } from "../api/github-app.js";
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
 * Settings → Context tree. Per-org Context Tree **configuration**: which repo /
 * branch the team's tree is bound to, plus the Context Reviewer feature.
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
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <Section
        title="Repository"
        description="The repository your team's Context Tree lives in. Changes apply to new agent sessions — members should restart their agents to pick up the change."
      >
        <div style={{ paddingTop: "var(--sp-4)" }}>
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
      </Section>

      <ContextReviewerSection hasBinding={hasBinding} isAdmin={isAdmin} />
    </div>
  );
}

/** Bound-tree summary: which repo / branch this team's tree lives in, a link into
 *  the live Context tab, and (admin) an Edit toggle for the manual binding form. */
function BoundTree({
  repo,
  branch,
  isAdmin,
  editing,
  onToggleEdit,
  onViewContext,
}: {
  repo: string;
  branch: string;
  isAdmin: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onViewContext: () => void;
}) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      {isAdmin ? (
        <div className="flex justify-end">
          <Button type="button" variant="link" className="h-auto p-0" onClick={onToggleEdit}>
            {editing ? "Close" : "Edit"}
          </Button>
        </div>
      ) : null}
      <span className="text-body mono" style={{ color: "var(--fg)", wordBreak: "break-all" }}>
        {repo}
      </span>
      <span className="text-label" style={{ color: "var(--fg-3)" }}>
        branch <span className="mono">{branch}</span>
      </span>
      <div style={{ marginTop: "var(--sp-1)" }}>
        <Button type="button" variant="link" className="h-auto p-0" onClick={onViewContext}>
          <span>View on the Context page</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
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
 *  only once a tree is bound. Was the old "Features" tab; now a plain section.
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
function ContextReviewerSection({ hasBinding, isAdmin }: { hasBinding: boolean; isAdmin: boolean }) {
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
  const serverWorkflow = featuresQuery.data?.contextReviewer.workflow ?? "legacy_app";
  const serverGovernance = featuresQuery.data?.contextReviewer.governance ?? "human";
  const serverMergeMethod = featuresQuery.data?.contextReviewer.mergeMethod ?? "squash";
  const installationQuery = useQuery({
    queryKey: ["github-app-installation", organizationId],
    queryFn: () => (organizationId ? getGithubAppInstallation(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId && hasBinding,
  });
  const installation = installationQuery.data ?? null;
  const appReviewReady =
    installation !== null && !installation.suspended && installation.permissions.pull_requests === "write";
  const requiresGithubApp = serverWorkflow === "legacy_app";
  const appReviewActionRequired = requiresGithubApp && !installationQuery.isLoading && !appReviewReady;
  const workflowReady = !requiresGithubApp || appReviewReady;

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
  const reviewerMissing = serverEnabled && !selectedIsCandidate && !agentsLoading && reviewerCandidates.length > 0;
  // Switch is on for setup but no agent chosen yet — prompt for the pick that
  // actually enables the feature.
  const awaitingAgent = setupOpen && !serverEnabled && !agentsLoading && reviewerCandidates.length > 0;

  const featuresMutation = useMutation({
    mutationFn: (next: OrgContextTreeFeaturesInput["contextReviewer"]) => {
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

  const reviewerConfig = (enabled: boolean, agentUuid: string | null) => ({
    enabled,
    agentUuid,
    workflow: serverWorkflow,
    governance: serverGovernance,
    mergeMethod: serverMergeMethod,
  });

  const handleToggle = (next: boolean) => {
    if (next) {
      if (!workflowReady) return;
      setSetupOpen(true);
      return;
    }
    setSetupOpen(false);
    if (serverEnabled) featuresMutation.mutate(reviewerConfig(false, null));
  };

  const handleSelectAgent = (uuid: string) => {
    if (!uuid) return;
    featuresMutation.mutate(reviewerConfig(true, uuid));
  };

  return (
    <Section
      title={titleWithSemantics("Context Reviewer", justSaved)}
      description="Assign an agent to review Context Tree PRs."
    >
      <div style={{ paddingTop: "var(--sp-4)" }}>
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
          <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
            {isAdmin ? (
              <div className="flex items-center justify-between" style={{ gap: "var(--sp-3)" }}>
                <span id={toggleLabelId} className="text-body font-medium" style={{ color: "var(--fg)" }}>
                  Automatic PR review
                </span>
                <Switch
                  checked={switchOn}
                  onCheckedChange={handleToggle}
                  disabled={saving || (!serverEnabled && !workflowReady)}
                  aria-labelledby={toggleLabelId}
                />
              </div>
            ) : (
              <ContextReviewerReadOnly
                contextReviewer={
                  featuresQuery.data?.contextReviewer ?? { enabled: false, agentUuid: null, reviewerAgent: null }
                }
              />
            )}

            {isAdmin && switchOn ? (
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
                    aria-label="Context Reviewer agent"
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
                    Select an agent to enable Context Reviewer.
                  </div>
                ) : null}
                {reviewerMissing ? (
                  <div className="text-label" style={{ color: "var(--fg-3)" }}>
                    Current reviewer is not an active organization agent. Choose another agent, or turn Context Reviewer
                    off.
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

            {appReviewActionRequired ? (
              <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
                <span className="text-body" style={{ color: "var(--warning)" }}>
                  Action required: the GitHub App installation must be active and grant Pull requests: write before it
                  can publish Context Reviewer results.
                </span>
                {installation?.manageUrl ? (
                  <a className="text-label" href={installation.manageUrl} target="_blank" rel="noreferrer">
                    Manage on GitHub
                  </a>
                ) : (
                  <span className="text-label" style={{ color: "var(--fg-3)" }}>
                    Connect the installation in Settings → GitHub.
                  </span>
                )}
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
    </Section>
  );
}

function agentLabel(agent: ManagedAgent): string {
  return agent.displayName.trim() || agent.name?.trim() || agent.uuid;
}

function ContextReviewerReadOnly({
  contextReviewer,
}: {
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
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <div className="flex items-center justify-between" style={{ gap: "var(--sp-3)" }}>
        <span className="text-body font-medium" style={{ color: "var(--fg)" }}>
          Automatic PR review
        </span>
        <span className="text-label" style={{ color: contextReviewer.enabled ? "var(--success)" : "var(--fg-3)" }}>
          {contextReviewer.enabled ? "On" : "Off"}
        </span>
      </div>
      {contextReviewer.enabled ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
          <span className="text-label font-medium" style={{ color: "var(--fg)" }}>
            Reviewer agent
          </span>
          <span className="text-body" style={{ color: reviewerLabel ? "var(--fg)" : "var(--fg-3)" }}>
            {reviewerLabel ?? "Configured reviewer is no longer available."}
          </span>
        </div>
      ) : null}
    </div>
  );
}
