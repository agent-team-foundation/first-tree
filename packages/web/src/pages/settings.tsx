import { useLocation, useNavigate } from "react-router";
import { PageHeader } from "../components/ui/page-header.js";
import { Tab, TabBar } from "../components/ui/tab-bar.js";
import { BindingsPage } from "./bindings.js";
import { MembershipPanel } from "./membership-panel.js";

const tabs = [
  { key: "bindings", label: "Bindings" },
  { key: "membership", label: "Membership" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

/**
 * User-facing Settings page. Post hub-ui-polish split: every signed-in member
 * sees `/settings` (Bindings is scoped per-role by the server). Admin-only
 * organization controls (Members, org system config) moved to `/admin`.
 *
 * Membership tab hosts the self-service "leave team" flow — visible to
 * every role per proposal §决策 #20.
 */
export function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const hashTab = location.hash.replace("#", "") as TabKey;
  const active: TabKey = tabs.some((t) => t.key === hashTab) ? hashTab : "bindings";

  const switchTab = (key: TabKey) => {
    navigate({ hash: key }, { replace: true });
  };

  return (
    <div className="-m-6">
      <PageHeader title="Settings" subtitle="Per-member controls" />
      <TabBar>
        {tabs.map((tab) => (
          <Tab key={tab.key} active={active === tab.key} onClick={() => switchTab(tab.key)}>
            {tab.label}
          </Tab>
        ))}
      </TabBar>
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        {active === "bindings" && <BindingsPage />}
        {active === "membership" && <MembershipPanel />}
      </div>
    </div>
  );
}
