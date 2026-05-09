import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { GithubIntegrationPanel } from "../github-integration-panel.js";

/**
 * Settings → GitHub. Admin-only — both `GET` and `PUT` of the underlying
 * `github_integration` namespace are admin-gated server-side, so a member
 * landing here would just see a 403 error in the panel. Redirect them
 * out instead.
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
      <PageHeader title="GitHub" subtitle="Webhook URL + secret for routing GitHub events to your agents" />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <GithubIntegrationPanel />
      </div>
    </>
  );
}
