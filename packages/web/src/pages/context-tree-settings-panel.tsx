import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { getContextTreeSetting, putContextTreeSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Section } from "../components/ui/section.js";
import { SettingsField, SettingsSaveButton } from "../components/ui/settings-field.js";

/**
 * Admin-only section for the per-org Context Tree binding (repo / branch).
 * Replaces the legacy global FIRST_TREE_CONTEXT_TREE_* env vars; each
 * org now points at its own tree.
 *
 * Changes apply to *new* agent sessions: client agents fetch the latest
 * binding at startup, existing sessions keep the value they were spun up
 * with. Admins should advise members to restart agents after editing.
 */
export function ContextTreeSettingsPanel() {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree"],
    queryFn: () => (organizationId ? getContextTreeSetting(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [saved, setSaved] = useState(false);

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
    mutation.mutate();
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
        <form onSubmit={handleSubmit}>
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
      )}
    </Section>
  );
}
