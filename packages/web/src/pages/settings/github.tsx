import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { GithubAppInstallationPanel } from "../github-app-installation-panel.js";
import { GithubIntegrationPanel } from "../github-integration-panel.js";

/**
 * Settings → GitHub. Admin-only — the underlying admin APIs (App
 * installation read + legacy `github_integration` namespace) are both
 * admin-gated server-side, so a member landing here would just see 403s
 * in the panels. Redirect them out instead.
 *
 * During the App-migration window this page renders BOTH:
 *   - GithubAppInstallationPanel — the new App-installation surface;
 *     shows the connected account + permissions + manage link.
 *   - GithubIntegrationPanel — the legacy per-repo webhook-secret panel;
 *     deleted in the D3 cutover commit later in this PR.
 *
 * Once the cutover lands only the App panel remains.
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
      <PageHeader title="GitHub" subtitle="App installation + legacy webhook configuration" />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <GithubAppInstallationPanel isFirst />
        <GithubIntegrationPanel />
      </div>
    </>
  );
}
