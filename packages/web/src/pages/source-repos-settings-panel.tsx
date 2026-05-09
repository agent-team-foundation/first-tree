import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getSourceReposSetting, putSourceReposSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { FlatSectionHeader } from "../components/ui/flat-section-header.js";

/**
 * Admin-only Team Settings card showing the team-level list of source
 * repositories. Onboarding writes one entry on Step 3; this card lets an
 * admin review what's bound and remove individual entries. There is no
 * "Add repo" form here yet — picking a repo requires an OAuth-scoped GitHub
 * picker and that lives in the onboarding flow today. A second pass will
 * extract the picker into a reusable component.
 */
export function SourceReposSettingsPanel() {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "source_repos"],
    queryFn: () => (organizationId ? getSourceReposSetting(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const removeMutation = useMutation({
    mutationFn: async (url: string) => {
      if (!organizationId) throw new Error("organization not loaded");
      const current = settingQuery.data?.repos ?? [];
      const next = current.filter((r) => r.url !== url);
      return putSourceReposSetting(organizationId, { repos: next });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["org-setting", organizationId, "source_repos"], next);
    },
  });

  const repos = settingQuery.data?.repos ?? [];

  return (
    <section>
      <FlatSectionHeader count={repos.length}>Source repos</FlatSectionHeader>
      {settingQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)", padding: "var(--sp-3) var(--sp-1)" }}>
          Loading…
        </div>
      ) : settingQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)", padding: "var(--sp-3) var(--sp-1)" }}>
          {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load setting"}
        </div>
      ) : repos.length === 0 ? (
        <div className="text-body" style={{ color: "var(--fg-3)", padding: "var(--sp-3) var(--sp-1)" }}>
          No source repos bound to this team yet. New repos are added during agent onboarding.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {repos.map((repo) => (
            <li
              key={repo.url}
              className="grid items-center gap-5"
              style={{
                gridTemplateColumns: "1fr auto",
                padding: "var(--sp-3_5) var(--sp-1)",
                borderTop: "var(--hairline) solid var(--border-faint)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div className="text-body mono" style={{ color: "var(--fg)", overflowWrap: "anywhere" }}>
                  {repo.url}
                </div>
                {repo.defaultBranch && (
                  <div className="text-label" style={{ color: "var(--fg-3)", marginTop: 2 }}>
                    branch: {repo.defaultBranch}
                  </div>
                )}
              </div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate(repo.url)}
              >
                <Trash2 className="h-3 w-3" />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="text-label" style={{ color: "var(--fg-3)", padding: "var(--sp-2) var(--sp-1) 0" }}>
        Removing a repo here only clears the team-level binding. Existing agent runtimes keep their per-agent gitRepos
        until an admin restarts the agent or edits its config directly.
      </div>
      {removeMutation.error instanceof Error && (
        <div className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
          {removeMutation.error.message}
        </div>
      )}
    </section>
  );
}
