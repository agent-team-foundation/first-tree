import { Navigate } from "react-router";
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
  if (role !== "admin") {
    return <Navigate to="/team" replace />;
  }

  return (
    <>
      <PageHeader title="Team settings" subtitle="Organization name, slug, and metadata" />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <OrgSettingsPage />
      </div>
    </>
  );
}
