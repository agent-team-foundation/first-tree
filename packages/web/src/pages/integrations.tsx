import { PageHeader } from "../components/ui/page-header.js";
import { BindingsPage } from "./bindings.js";

/**
 * External platform connection surface. Hosts adapter and user bindings.
 * `embedded` drops the full-bleed `-m-6` wrapper so this page can be
 * rendered inside another master-detail container (e.g. /settings).
 */
export function IntegrationsPage({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <div className={embedded ? "" : "-m-6"}>
      <PageHeader title="Integrations" subtitle="External platform bindings" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        <BindingsPage />
      </div>
    </div>
  );
}
