import { Navigate, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { PageHeader } from "../components/ui/page-header.js";
import { Tab, TabBar } from "../components/ui/tab-bar.js";
import { AdminAllAgentsPage } from "./admin-all-agents.js";
import { MembersPage } from "./members.js";
import { OrgSettingsPage } from "./org-settings.js";

const tabs = [
  { key: "members", label: "Members" },
  { key: "all-agents", label: "All agents" },
  { key: "settings", label: "Org settings" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

export function AdminPage() {
  const { role } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  if (role === null) {
    return (
      <div className="text-body" style={{ padding: 20, color: "var(--fg-3)" }}>
        Loading…
      </div>
    );
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
    <div className="-m-6">
      <PageHeader title="Admin" subtitle="Organization-wide controls" />
      <TabBar>
        {tabs.map((tab) => (
          <Tab key={tab.key} active={active === tab.key} onClick={() => switchTab(tab.key)}>
            {tab.label}
          </Tab>
        ))}
      </TabBar>
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        {active === "members" && <MembersPage />}
        {active === "all-agents" && <AdminAllAgentsPage />}
        {active === "settings" && <OrgSettingsPage />}
      </div>
    </div>
  );
}
