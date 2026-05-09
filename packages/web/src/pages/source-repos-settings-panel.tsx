import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { getSourceReposSetting, putSourceReposSetting } from "../api/org-settings.js";
import { useAuth } from "../auth/auth-context.js";
import { SettingsSection } from "../components/ui/settings-section.js";

/**
 * Team Settings section showing the team-level list of source
 * repositories.
 *
 * Admins get full management — list + per-entry remove (hover-revealed
 * `×` icon). Members see the same list but read-only with a footer
 * explaining that only admins can edit. The `source_repos` namespace's
 * server-side `readPolicy: "member"` makes the GET succeed for non-admins;
 * PUT stays admin-only so the Remove control is hidden for members rather
 * than just disabled (avoids a 403 the UI can't recover from gracefully).
 *
 * Onboarding writes one entry on Step 3 (admin path). There is no
 * "Add repo" form here yet — picking a repo requires an OAuth-scoped
 * GitHub picker and that lives in the onboarding flow today. A second
 * pass will extract the picker into a reusable component.
 */
export function SourceReposSettingsPanel({ isFirst = false }: { isFirst?: boolean }) {
  const { organizationId, role } = useAuth();
  const isAdmin = role === "admin";
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

  const countBadge =
    repos.length > 0 ? (
      <span className="text-label" style={{ color: "var(--fg-4)" }}>
        {repos.length}
      </span>
    ) : null;

  return (
    <SettingsSection
      title="Source repos"
      description={
        isAdmin
          ? "Repos your team's agents are bound to. New repos are added during agent onboarding."
          : "Repos your team's agents are bound to. Read-only — only admins can edit."
      }
      right={countBadge}
      isFirst={isFirst}
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
            <RepoRow
              key={repo.url}
              url={repo.url}
              defaultBranch={repo.defaultBranch}
              isAdmin={isAdmin}
              isRemoving={removeMutation.isPending}
              onRemove={() => removeMutation.mutate(repo.url)}
            />
          ))}
        </ul>
      )}
      {removeMutation.error instanceof Error && (
        <div className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
          {removeMutation.error.message}
        </div>
      )}
    </SettingsSection>
  );
}

function RepoRow({
  url,
  defaultBranch,
  isAdmin,
  isRemoving,
  onRemove,
}: {
  url: string;
  defaultBranch?: string;
  isAdmin: boolean;
  isRemoving: boolean;
  onRemove: () => void;
}) {
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
          <div className="text-label" style={{ color: "var(--fg-4)", marginTop: 2 }}>
            branch: {defaultBranch}
          </div>
        )}
      </div>
      {isAdmin && (
        <button
          type="button"
          aria-label={`Remove ${url}`}
          disabled={isRemoving}
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: 0,
            borderRadius: "var(--rd-1)",
            background: "transparent",
            color: "var(--fg-3)",
            cursor: isRemoving ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--surface-2)";
            e.currentTarget.style.color = "var(--fg)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--fg-3)";
          }}
        >
          <X className="h-3_5 w-3_5" style={{ width: 14, height: 14 }} />
        </button>
      )}
    </li>
  );
}
