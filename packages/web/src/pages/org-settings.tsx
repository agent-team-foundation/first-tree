import { useAuth } from "../auth/auth-context.js";
import { ContextTreeSettingsPanel } from "./context-tree-settings-panel.js";
import { TeamIdentityPanel } from "./team-identity-panel.js";

/**
 * Per-org settings page (Settings → Team).
 *
 * Admin sees two panels:
 *   1. TeamIdentityPanel — display name + short identifier
 *   2. ContextTreeSettingsPanel — per-org Context Tree binding
 *
 * Source repo management moved to Team Resources. The legacy
 * `source_repos` setting remains readable for migration compatibility, but
 * this page no longer presents it as an editable product surface.
 *
 * GitHub integration (webhook URL + secret) used to live here too, but
 * it's an external-platform bridge so it moved to `/settings/github`.
 * This page is now pure team metadata + internal binding.
 *
 * Earlier versions of this page also exposed the global "System
 * configuration" panel (inbox_timeout / max_retry / polling_interval /
 * presence_cleanup); those moved to deployment-level env vars and the
 * UI / API surface was removed.
 */
export function OrgSettingsPage() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  return (
    <div>
      {isAdmin && <TeamIdentityPanel />}
      {isAdmin && <ContextTreeSettingsPanel />}
    </div>
  );
}
