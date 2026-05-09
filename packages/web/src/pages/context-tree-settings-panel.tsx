import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { getContextTreeSetting, putContextTreeSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { FlatSectionHeader } from "../components/ui/flat-section-header.js";

/**
 * Admin-only panel for the per-org Context Tree binding (repo / branch /
 * localPath). Replaces the legacy global FIRST_TREE_HUB_CONTEXT_TREE_*
 * env vars; each org now points at its own tree.
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
    <section>
      <FlatSectionHeader
        right={
          <div className="flex items-center gap-1.5">
            {saved && (
              <span className="mono text-caption" style={{ color: "var(--accent-dim)" }}>
                saved
              </span>
            )}
            <Button
              type="submit"
              form="context-tree-form"
              size="xs"
              variant="outline"
              disabled={mutation.isPending || !settingQuery.data}
            >
              <Check className="h-3 w-3" />
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      >
        Context Tree
      </FlatSectionHeader>
      {settingQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)", padding: "var(--sp-3) var(--sp-1)" }}>
          Loading…
        </div>
      ) : settingQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)", padding: "var(--sp-3) var(--sp-1)" }}>
          {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load setting"}
        </div>
      ) : (
        <form id="context-tree-form" onSubmit={handleSubmit}>
          <Field
            label="Repo URL"
            hint="HTTPS or SSH URL of the Context Tree git repository for this team."
            value={repo}
            onChange={setRepo}
            mono
            placeholder="https://github.com/your-org/first-tree-context"
          />
          <Field
            label="Branch"
            hint="Branch checked out by client agents on startup."
            value={branch}
            onChange={setBranch}
            mono
            placeholder="main"
          />
          <div className="text-label" style={{ color: "var(--fg-3)", padding: "var(--sp-2) var(--sp-1) 0" }}>
            Changes apply to new agent sessions. Members should restart agents to pick up updated tree contents.
          </div>
          {mutation.error instanceof Error && (
            <div className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
              {mutation.error.message}
            </div>
          )}
        </form>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  mono,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <div
      className="grid items-start gap-5"
      style={{
        gridTemplateColumns: "var(--sp-45) 1fr",
        padding: "var(--sp-3_5) var(--sp-1)",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {label}
        </div>
        <div className="text-label" style={{ color: "var(--fg-3)", marginTop: 2 }}>
          {hint}
        </div>
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full outline-none text-body ${mono ? "mono" : ""}`}
        style={{
          padding: "var(--sp-1_25) var(--sp-2_5)",
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg)",
        }}
      />
    </div>
  );
}
