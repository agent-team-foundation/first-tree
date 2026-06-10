import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { getContextTreeSetting, putContextTreeSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Section } from "../components/ui/section.js";
import { SettingsField, SettingsSaveButton } from "../components/ui/settings-field.js";
import { COPY } from "./onboarding/copy.js";

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

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree"],
    queryFn: () => (organizationId ? getContextTreeSetting(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [saved, setSaved] = useState(false);
  const hasConfiguredRepo = !!settingQuery.data?.repo;

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
          {isAdmin && !hasConfiguredRepo ? (
            <div style={{ marginBottom: "var(--sp-4)" }}>
              {/* No green "create repo" button — the team's tree is built via the
                  /build-tree flow (connect code -> build -> seed). The form below
                  stays for pointing at an EXISTING tree (paste a repo URL). */}
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => navigate("/build-tree")}>
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
              isAdmin ? <SettingsSaveButton pending={mutation.isPending} disabled={!settingQuery.data} /> : undefined
            }
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
