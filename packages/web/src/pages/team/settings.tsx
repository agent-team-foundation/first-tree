import { useAuth } from "../../auth/auth-context.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { OrgSettingsPage } from "../org-settings.js";

export function TeamSettingsPage() {
  const { role } = useAuth();

  if (role === null) {
    return (
      <div className="text-body" style={{ padding: "var(--sp-5)", color: "var(--fg-3)" }}>
        Loading...
      </div>
    );
  }

  // Members see the page too — `OrgSettingsPage` mounts only the panels
  // their role can read. Today that's just `SourceReposSettingsPanel`
  // (read-only). The other panels (TeamIdentity / ContextTree /
  // GithubIntegration) stay admin-only because their underlying APIs are
  // admin-gated for write and showing an empty form to a non-admin
  // confuses more than it helps.
  const subtitle =
    role === "admin" ? "Identity, Context Tree, GitHub integration" : "Repos your team's agents are bound to";

  return (
    <>
      <PageHeader title="Team settings" subtitle={subtitle} />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <OrgSettingsPage />
      </div>
    </>
  );
}
