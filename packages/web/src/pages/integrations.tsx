import { PageHeader } from "../components/ui/page-header.js";
import { BindingsPage } from "./bindings.js";

/**
 * External platform connection surface. This replaces the old top-level
 * settings tab for adapter and user bindings, keeping integrations available
 * to non-admin members while team administration moves behind the user menu.
 */
export function IntegrationsPage() {
  return (
    <div className="-m-6">
      <PageHeader title="Integrations" subtitle="External platform bindings" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        <BindingsPage />
      </div>
    </div>
  );
}
