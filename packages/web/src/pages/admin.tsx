import { Navigate, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { AdminAllAgentsPage } from "./admin-all-agents.js";
import { MembersPage } from "./members.js";
import { OrgSettingsPage } from "./org-settings.js";

const tabs = [
  { key: "members", label: "Members" },
  { key: "all-agents", label: "All Agents" },
  { key: "settings", label: "Org Settings" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

export function AdminPage() {
  const { role } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // `role` is null until the first `/me` response lands. Rendering the
  // admin shell while we wait would flash admin-only UI to a non-admin
  // for a tick — gate on role being resolved. Server-side enforcement
  // still lives on the individual admin routes; this is only here to
  // keep the UI honest during the loading window.
  if (role === null) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (role !== "admin") {
    return <Navigate to="/settings" replace />;
  }

  const hashTab = location.hash.replace("#", "") as TabKey;
  const active: TabKey = tabs.some((t) => t.key === hashTab) ? hashTab : "members";

  const switchTab = (key: TabKey) => {
    navigate({ hash: key }, { replace: true });
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Admin</h1>
      <div className="flex gap-1 border-b border-border mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => switchTab(tab.key)}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              active === tab.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active === "members" && <MembersPage />}
      {active === "all-agents" && <AdminAllAgentsPage />}
      {active === "settings" && <OrgSettingsPage />}
    </div>
  );
}
