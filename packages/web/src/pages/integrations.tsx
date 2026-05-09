import { PageHeader } from "../components/ui/page-header.js";
import { BindingsPage } from "./bindings.js";

/**
 * Messaging platform bridges — Feishu / Slack adapter and user bindings.
 * GitHub used to live here too but moved to its own /settings/github tab
 * (its config form is shaped differently from the IM adapter CRUD).
 *
 * `embedded` drops the full-bleed `-m-6` wrapper so this page can be
 * rendered inside another master-detail container (e.g. /settings).
 */
export function IntegrationsPage({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <div className={embedded ? "" : "-m-6"}>
      <PageHeader title="Messaging" subtitle="Feishu / Slack bridges to your team's agents" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        <BindingsPage />
      </div>
    </div>
  );
}
