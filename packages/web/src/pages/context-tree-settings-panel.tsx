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
import { Tab, TabBar } from "../components/ui/tab-bar.js";
import { COPY } from "./onboarding/copy.js";

type ContextTreeSettingsTab = "initial" | "features";

/**
 * Section for the per-org Context Tree binding (repo / branch). Replaces the
 * legacy global FIRST_TREE_CONTEXT_TREE_* env vars; each org now points at its
 * own tree.
 *
 * Members may *read* the binding (the `context_tree` namespace is
 * `readPolicy: "member"`) so they can see which tree their agents read from;
 * only admins may edit it. For members the form renders read-only with no
 * Save affordance.
 *
 * Changes apply to *new* agent sessions: client agents fetch the latest
 * binding at startup, existing sessions keep the value they were spun up
 * with. Admins should advise members to restart agents after editing.
 */
export function ContextTreeSettingsPanel() {
  const { organizationId, role } = useAuth();
  const isAdmin = role === "admin";
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<ContextTreeSettingsTab>("initial");
  const [manualEnabled, setManualEnabled] = useState(false);

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree"],
    queryFn: () => (organizationId ? getContextTreeSetting(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [saved, setSaved] = useState(false);
  const hasConfiguredRepo = !!settingQuery.data?.repo;

  const featuresQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree_features"],
    queryFn: () =>
      organizationId ? getContextTreeFeaturesSetting(organizationId) : Promise.reject(new Error("no org")),
    enabled: !!organizationId && isAdmin,
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
    enabled: !!organizationId && isAdmin && reviewerEnabled,
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
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    // Read-only UI must not initiate a write: members have no Save button, but
    // pressing Enter inside a read-only field would still submit the form. The
    // server 403s a member PUT regardless, but the client shouldn't fire it.
    if (!isAdmin) return;
    mutation.mutate();
  };

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
    if (!isAdmin || featuresSaveDisabled) return;
    featuresMutation.mutate();
  };

  return (
    <Section
      title="Context tree"
      description="Changes apply to new agent sessions. Members should restart agents to pick up updated tree contents."
    >
      {settingQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      ) : settingQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load setting"}
        </div>
      ) : (
        <div>
          <TabBar role="tablist" aria-label="Context tree settings tabs" style={{ padding: 0 }}>
            <Tab
              id="context-tree-settings-initial-tab"
              role="tab"
              aria-selected={activeTab === "initial"}
              aria-controls="context-tree-settings-initial-panel"
              active={activeTab === "initial"}
              onClick={() => setActiveTab("initial")}
            >
              Initial
            </Tab>
            <Tab
              id="context-tree-settings-features-tab"
              role="tab"
              aria-selected={activeTab === "features"}
              aria-controls="context-tree-settings-features-panel"
              active={activeTab === "features"}
              onClick={() => setActiveTab("features")}
            >
              Features
            </Tab>
          </TabBar>

          {activeTab === "initial" ? (
            <div
              id="context-tree-settings-initial-panel"
              role="tabpanel"
              aria-labelledby="context-tree-settings-initial-tab"
              style={{ paddingTop: "var(--sp-4)" }}
            >
              {isAdmin ? (
                <div style={{ marginBottom: "var(--sp-4)" }}>
                  {/* The team's tree is built via the /build-tree flow
                      (connect code -> build -> seed). Manual settings below are
                      only for pointing at an existing tree repo. */}
                  <Button type="button" onClick={() => navigate("/build-tree")}>
                    <span>{COPY.buildTree.buildCta}</span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
              {!isAdmin && !hasConfiguredRepo ? (
                <div className="text-body" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-4)" }}>
                  Ask an admin to initialize this team's Context Tree.
                </div>
              ) : null}
              <label
                className="text-body inline-flex items-center"
                style={{ color: "var(--fg)", gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}
              >
                <input type="checkbox" checked={manualEnabled} onChange={(e) => setManualEnabled(e.target.checked)} />
                <span>Manual Set</span>
              </label>
              {manualEnabled ? (
                <form onSubmit={handleSubmit}>
                  <SettingsField
                    label="Repo URL"
                    hint="HTTPS URL of the Context Tree git repository for this team."
                    value={repo}
                    onChange={setRepo}
                    mono
                    placeholder="https://github.com/your-org/first-tree-context"
                    readOnly={!isAdmin}
                  />
                  <SettingsField
                    label="Branch"
                    hint="Branch checked out by client agents on startup."
                    value={branch}
                    onChange={setBranch}
                    mono
                    placeholder="main"
                    readOnly={!isAdmin}
                    saved={saved}
                    rightSlot={
                      isAdmin ? (
                        <SettingsSaveButton pending={mutation.isPending} disabled={!settingQuery.data} />
                      ) : undefined
                    }
                  />
                  {mutation.error instanceof Error && (
                    <div className="text-body" style={{ color: "var(--state-error)" }}>
                      {mutation.error.message}
                    </div>
                  )}
                </form>
              ) : null}
            </div>
          ) : (
            <div
              id="context-tree-settings-features-panel"
              role="tabpanel"
              aria-labelledby="context-tree-settings-features-tab"
              style={{ paddingTop: "var(--sp-4)" }}
            >
              {isAdmin ? (
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
                      <span>Context Reviewer</span>
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
                  <p className="text-label" style={{ color: "var(--fg-3)", margin: "var(--sp-0_5) 0 0" }}>
                    Assign one of your active agents to review Context Tree updates for this team.
                  </p>

                  <div style={{ marginTop: "var(--sp-4)" }}>
                    {featuresQuery.isLoading ? (
                      <div className="text-body" style={{ color: "var(--fg-3)" }}>
                        Loading…
                      </div>
                    ) : featuresQuery.error ? (
                      <div className="text-body" style={{ color: "var(--state-error)" }}>
                        {featuresQuery.error instanceof Error
                          ? featuresQuery.error.message
                          : "Failed to load feature settings"}
                      </div>
                    ) : reviewerEnabled ? (
                      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
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
                            Current reviewer is not your active agent. Choose one of your agents or turn Context
                            Reviewer off.
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="text-body" style={{ color: "var(--fg-3)" }}>
                        Context Reviewer is disabled.
                      </div>
                    )}
                  </div>

                  <div
                    className="flex items-center justify-end"
                    style={{ gap: "var(--sp-2)", marginTop: "var(--sp-4)" }}
                  >
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
              ) : (
                <div className="text-body" style={{ color: "var(--fg-3)" }}>
                  Only admins can configure Context Reviewer.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function agentLabel(agent: ManagedAgent): string {
  return agent.displayName.trim() || agent.name?.trim() || agent.uuid;
}
