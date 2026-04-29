import { PageHeader } from "../components/ui/page-header.js";
import { BindingsPage } from "./bindings.js";

/**
 * User-facing Settings page. Post hub-ui-polish split: every signed-in member
 * sees `/settings` (Bindings is scoped per-role by the server). Admin-only
 * organization controls (Members, org system config) moved to `/admin`.
 *
 * Computer-level info (registered machines + their runtime-provider capability
 * matrix) lives on `/clients`, not here, so the operator answers "which
 * machines can run what" in one place.
 */
export function SettingsPage() {
  return (
    <div className="-m-6">
      <PageHeader title="Settings" subtitle="Per-member controls" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        <BindingsPage />
      </div>
    </div>
  );
}
