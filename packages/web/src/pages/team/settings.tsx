import { Navigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { TeamIdentityPanel } from "../team-identity-panel.js";

/**
 * Settings → Team profile. Org-scoped team identity (display name).
 *
 * Admin-only: the only thing here is the org rename form, whose underlying
 * API is admin-gated for write. There's nothing for a member to read, so we
 * hide the nav entry (see settings.tsx) and redirect a member who deep-links
 * here — same pattern as Settings → GitHub.
 *
 * Context Tree binding and runtime Resources used to share this page; they
 * now live at /settings/context and /settings/resources respectively, each a
 * single cohesive surface.
 */
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
    return <Navigate to="/settings/computers" replace />;
  }

  return (
    <>
      <PageHeader title="Team profile" subtitle="Your team's display name." />
      <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
        <TeamIdentityPanel />
      </div>
    </>
  );
}
