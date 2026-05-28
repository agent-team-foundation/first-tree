import { PageHeader } from "../components/ui/page-header.js";
import { BindingsPage } from "./bindings.js";

/**
 * Kael adapter bindings page. GitHub used to live here too but moved to
 * its own /settings/github tab (its config form is shaped differently from
 * the adapter CRUD).
 *
 * `embedded` drops the full-bleed `-m-6` wrapper so this page can be
 * rendered inside another master-detail container (e.g. /settings).
 */
export function IntegrationsPage({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <div className={embedded ? "" : "-m-6"}>
      <PageHeader title="Messaging" subtitle="Kael adapter bindings for your team's agents" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        <BindingsPage />
      </div>
    </div>
  );
}
