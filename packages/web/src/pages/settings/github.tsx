import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { GithubAppInstallationPanel } from "../github-app-installation-panel.js";

/**
 * Settings → GitHub. Admin-only — the App installation admin API is
 * admin-gated server-side, so a member landing here would just see a
 * 403 in the panel. Redirect them out instead.
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
      <PageHeader title="GitHub" subtitle="Connected GitHub App and granted permissions" />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <GithubAppInstallationPanel />
      </div>
    </>
  );
}
