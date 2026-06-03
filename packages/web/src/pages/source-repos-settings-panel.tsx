import { useQuery } from "@tanstack/react-query";
import { getSourceReposSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { Section } from "../components/ui/section.js";

/**
 * Team Settings section showing the team-level list of source
 * repositories.
 *
 * Legacy read-only view for pre-Resources `source_repos` rows. The
 * namespace remains member-readable so old team setup is understandable
 * during migration, but writes now go through Team Resources only.
 */
export function SourceReposSettingsPanel() {
  const { organizationId } = useAuth();

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "source_repos"],
    queryFn: () => (organizationId ? getSourceReposSetting(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const repos = settingQuery.data?.repos ?? [];

  const countBadge =
    repos.length > 0 ? (
      <span className="text-label" style={{ color: "var(--fg-4)" }}>
        {repos.length}
      </span>
    ) : null;

  return (
    <Section
      title="Source repos"
      description="Legacy source repo setting. Manage active repo resources from Team Resources."
      action={countBadge}
    >
      {settingQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      ) : settingQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load setting"}
        </div>
      ) : repos.length === 0 ? (
        <div
          className="text-body"
          style={{
            color: "var(--fg-3)",
            padding: "var(--sp-3) var(--sp-2_5)",
            background: "var(--bg-sunken)",
            borderRadius: "var(--radius-input)",
          }}
        >
          No source repos bound yet.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {repos.map((repo) => (
            <RepoRow key={repo.url} url={repo.url} defaultBranch={repo.defaultBranch} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function RepoRow({ url, defaultBranch }: { url: string; defaultBranch?: string }) {
  return (
    <li
      className="group flex items-center"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-2) var(--sp-2_5)",
        borderRadius: "var(--radius-input)",
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-body mono" style={{ color: "var(--fg)", overflowWrap: "anywhere" }}>
          {url}
        </div>
        {defaultBranch && (
          <div className="text-label" style={{ color: "var(--fg-4)", marginTop: "var(--sp-0_5)" }}>
            branch: {defaultBranch}
          </div>
        )}
      </div>
    </li>
  );
}
