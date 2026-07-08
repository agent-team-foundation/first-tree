import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Section } from "../../components/ui/section.js";
import { GithubAppInstallationPanel } from "../github-app-installation-panel.js";
import { ResourceTypeSections } from "./resource-sections.js";

/**
 * Settings → GitHub. Admin-only — the App installation admin API is
 * admin-gated server-side, so a member landing here would just see a
 * 403 in the panel. Redirect them out instead.
 *
 * Two sections:
 *   - GitHub Connection — the GitHub App installation panel (connect /
 *     disconnect / install).
 *   - Source Repos — the team's `repo` runtime resources, moved here from
 *     Settings → Resources so the repos agents work on sit next to the
 *     GitHub connection their code and events flow through.
 */
export function SettingsGithubPage() {
  const { role } = useAuth();
  if (role === null) {
    return (
      <div className="text-body" style={{ padding: "var(--sp-5)", color: "var(--fg-3)" }}>
        Loading...
      </div>
    );
  }
  if (role !== "admin") {
    return <Navigate to="/settings/computers" replace />;
  }

  return (
    <>
      <PageHeader title="GitHub" subtitle="GitHub App connection and the source repos agents work on" />
      <div className="flex flex-col" style={{ gap: "var(--sp-5)", padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <Section title="GitHub Connection">
          <GithubAppInstallationPanel />
        </Section>
        <ResourceTypeSections types={["repo"]} titleFor={() => "Source Repos"} />
      </div>
    </>
  );
}
