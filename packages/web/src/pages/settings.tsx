import { BindingsPage } from "./bindings.js";

/**
 * User-facing Settings page. Post hub-ui-polish split: every signed-in member
 * sees `/settings` (Bindings is scoped per-role by the server). Admin-only
 * organization controls (Members, org system config) moved to `/admin`.
 */
export function SettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      <BindingsPage />
    </div>
  );
}
