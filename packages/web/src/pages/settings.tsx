import { PageHeader } from "../components/ui/page-header.js";
import { Tab, TabBar } from "../components/ui/tab-bar.js";
import { BindingsPage } from "./bindings.js";

/**
 * User-facing Settings page. Post hub-ui-polish split: every signed-in member
 * sees `/settings` (Bindings is scoped per-role by the server). Admin-only
 * organization controls (Members, org system config) moved to `/admin`.
 */
export function SettingsPage() {
  return (
    <div className="-m-6">
      <PageHeader title="Settings" subtitle="Per-member controls" />
      <TabBar>
        <Tab active>Bindings</Tab>
      </TabBar>
      <div style={{ padding: "16px 20px 28px" }}>
        <BindingsPage />
      </div>
    </div>
  );
}
