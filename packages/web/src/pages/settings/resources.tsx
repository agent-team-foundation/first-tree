import { RESOURCE_TYPES } from "./resource-editors.js";
import { ResourceTypeSections } from "./resource-sections.js";

/**
 * Settings → Resources. Org-scoped runtime resources (prompt / skill / mcp)
 * the team's agents consume. Lives under Settings (an org-admin config
 * surface), not on the Team roster — see the Settings IA in settings.tsx.
 *
 * The `repo` type is deliberately absent here: source repos render on
 * Settings → GitHub as the "Source Repos" section, next to the GitHub App
 * connection their code and events flow through.
 *
 * Visible to all members. Everyone can open the read-only preview; only
 * admins see add / edit / retire affordances (see ResourceTypeSections).
 */
export function SettingsResourcesPage() {
  // Page heading + lead are owned by the Settings layout (see settings.tsx).
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
      <ResourceTypeSections types={RESOURCE_TYPES.filter((type) => type !== "repo")} />
    </div>
  );
}
