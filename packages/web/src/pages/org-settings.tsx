import { TeamIdentityPanel } from "./team-identity-panel.js";

/**
 * Per-org settings page. The former "System configuration" panel
 * (inbox_timeout / max_retry / polling_interval / presence_cleanup) was
 * removed when those four knobs were promoted to deployment-level env vars
 * (FIRST_TREE_HUB_INBOX_TIMEOUT_SECONDS, etc.). Operators tune them via
 * the deploy manifest now — the API surface is gone, so the UI is too.
 */
export function OrgSettingsPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      <TeamIdentityPanel />
    </div>
  );
}
