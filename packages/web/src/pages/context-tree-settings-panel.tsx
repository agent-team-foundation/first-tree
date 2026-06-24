import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listManagedAgents, type ManagedAgent } from "../api/agents.js";
import {
  getContextTreeFeaturesSetting,
  getContextTreeSetting,
  putContextTreeFeaturesSetting,
  putContextTreeSetting,
} from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Section } from "../components/ui/section.js";
import { Select } from "../components/ui/select.js";
import { SettingsField, SettingsSaveButton } from "../components/ui/settings-field.js";

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
    queryKey: ["org-setting", organizationId, "context_tree"],
    queryFn: () => (organizationId ? getContextTreeSetting(organizationId) : Promise.reject(new Error("no org"))),
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
      queryClient.setQueryData(["org-setting", organizationId, "context_tree"], next);
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
                hint="Branch checked out by client agents on startup."
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

      {isAdmin ? <ContextReviewerSection hasBinding={hasBinding} /> : null}
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
      <div className="flex items-baseline justify-between" style={{ gap: "var(--sp-3)" }}>
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          Your team's Context Tree
        </span>
        {isAdmin ? (
          <Button type="button" variant="link" className="h-auto p-0" onClick={onToggleEdit}>
            {editing ? "Close" : "Edit"}
          </Button>
        ) : null}
      </div>
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
 *  only once a tree is bound. Was the old "Features" tab; now a plain section. */
function ContextReviewerSection({ hasBinding }: { hasBinding: boolean }) {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();

  const featuresQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree_features"],
    queryFn: () =>
      organizationId ? getContextTreeFeaturesSetting(organizationId) : Promise.reject(new Error("no org")),
    enabled: !!organizationId,
  });

  const [reviewerEnabled, setReviewerEnabled] = useState(false);
  const [reviewerAgentUuid, setReviewerAgentUuid] = useState<string | null>(null);
  const [featuresSaved, setFeaturesSaved] = useState(false);

  useEffect(() => {
    if (!featuresQuery.data) return;
    setReviewerEnabled(featuresQuery.data.contextReviewer.enabled);
    setReviewerAgentUuid(featuresQuery.data.contextReviewer.agentUuid);
  }, [featuresQuery.data]);

  const managedAgentsQuery = useQuery({
    queryKey: ["context-reviewer", "managed-agents", organizationId],
    queryFn: listManagedAgents,
    enabled: !!organizationId && reviewerEnabled,
  });

  const reviewerCandidates = useMemo(() => {
    return (managedAgentsQuery.data ?? [])
      .filter((agent) => agent.organizationId === organizationId && agent.type !== "human" && agent.status === "active")
      .sort((a, b) => {
        const byLabel = agentLabel(a).localeCompare(agentLabel(b), undefined, { sensitivity: "base" });
        return byLabel === 0 ? a.uuid.localeCompare(b.uuid) : byLabel;
      });
  }, [managedAgentsQuery.data, organizationId]);

  const selectedReviewerIsCandidate = reviewerCandidates.some((agent) => agent.uuid === reviewerAgentUuid);
  const reviewerSelectionInvalid = reviewerEnabled && (!reviewerAgentUuid || !selectedReviewerIsCandidate);
  const featuresSaveDisabled =
    featuresQuery.isLoading ||
    featuresQuery.isError ||
    managedAgentsQuery.isLoading ||
    (reviewerEnabled && (reviewerCandidates.length === 0 || reviewerSelectionInvalid));

  const featuresMutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("organization not loaded");
      return putContextTreeFeaturesSetting(organizationId, {
        contextReviewer: {
          enabled: reviewerEnabled,
          agentUuid: reviewerEnabled ? reviewerAgentUuid : null,
        },
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["org-setting", organizationId, "context_tree_features"], next);
      setFeaturesSaved(true);
      setTimeout(() => setFeaturesSaved(false), 2000);
    },
  });

  const handleFeaturesSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (featuresSaveDisabled) return;
    featuresMutation.mutate();
  };

  return (
    <Section
      title="Context Reviewer"
      description="Assign one of your agents to automatically review Context Tree pull requests."
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
          <form onSubmit={handleFeaturesSubmit}>
            <div className="flex items-baseline justify-between" style={{ gap: "var(--sp-2)" }}>
              <label
                className="text-body inline-flex items-center font-medium"
                style={{ color: "var(--fg)", gap: "var(--sp-2)" }}
              >
                <input
                  type="checkbox"
                  checked={reviewerEnabled}
                  onChange={(e) => {
                    setReviewerEnabled(e.target.checked);
                    if (!e.target.checked) setReviewerAgentUuid(null);
                  }}
                />
                <span>Enabled</span>
              </label>
              {featuresSaved && (
                <span
                  className="text-label inline-flex items-center fade-in"
                  style={{ gap: "var(--sp-1)", color: "var(--fg-confirm)" }}
                >
                  <Check className="h-3 w-3" />
                  Saved
                </span>
              )}
            </div>

            {reviewerEnabled ? (
              <div className="flex flex-col" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-4)" }}>
                <span className="text-label font-medium" style={{ color: "var(--fg)" }}>
                  Reviewer agent
                </span>
                {managedAgentsQuery.isLoading ? (
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
                    value={selectedReviewerIsCandidate ? (reviewerAgentUuid ?? "") : ""}
                    onChange={(value) => setReviewerAgentUuid(value || null)}
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
                {managedAgentsQuery.error ? (
                  <div className="text-body" style={{ color: "var(--state-error)" }}>
                    {managedAgentsQuery.error instanceof Error
                      ? managedAgentsQuery.error.message
                      : "Failed to load agents"}
                  </div>
                ) : null}
                {reviewerAgentUuid && !selectedReviewerIsCandidate && !managedAgentsQuery.isLoading ? (
                  <div className="text-label" style={{ color: "var(--fg-3)" }}>
                    Current reviewer is not your active agent. Choose one of your agents or turn Context Reviewer off.
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-end" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-4)" }}>
              <Button type="submit" size="sm" disabled={featuresMutation.isPending || featuresSaveDisabled}>
                <Check className="h-4 w-4" />
                <span>Save</span>
              </Button>
            </div>
            {featuresMutation.error instanceof Error && (
              <div className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
                {featuresMutation.error.message}
              </div>
            )}
          </form>
        )}
      </div>
    </Section>
  );
}

function agentLabel(agent: ManagedAgent): string {
  return agent.displayName.trim() || agent.name?.trim() || agent.uuid;
}
