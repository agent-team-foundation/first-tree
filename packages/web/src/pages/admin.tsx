import { useLocation, useNavigate } from "react-router";
import { cn } from "../lib/utils.js";
import { BindingsPage } from "./bindings.js";
import { MembersPage } from "./members.js";
import { SettingsPage } from "./settings.js";

const tabs = [
  { key: "members", label: "Members" },
  { key: "settings", label: "Settings" },
  { key: "bindings", label: "Bindings" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

export function AdminPage() {
  const location = useLocation();
  const navigate = useNavigate();
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
      {active === "settings" && <SettingsPage />}
      {active === "bindings" && <BindingsPage />}
    </div>
  );
}
