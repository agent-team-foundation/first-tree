import { useAuth } from "../auth/auth-context.js";
import { ContextTreeSettingsPanel } from "./context-tree-settings-panel.js";
import { SourceReposSettingsPanel } from "./source-repos-settings-panel.js";
import { TeamIdentityPanel } from "./team-identity-panel.js";

/**
 * Per-org settings page (Settings → Team).
 *
 * Admin sees three panels:
 *   1. TeamIdentityPanel — display name + short identifier
 *   2. ContextTreeSettingsPanel — per-org Context Tree binding
 *   3. SourceReposSettingsPanel — team-level list of bound source repos
 *
 * Members see only `SourceReposSettingsPanel` (read-only). The
 * `source_repos` namespace sets `readPolicy: "member"` server-side, so
 * a member can GET the list but cannot mutate it. The other two panels
 * stay admin-only — their APIs are admin-gated for write, and rendering
 * an empty form to a non-admin is more confusing than helpful.
 *
 * GitHub integration (webhook URL + secret) used to live here too, but
 * it's an external-platform bridge — same shape as Feishu / Slack
 * adapters — so it moved to `/settings/github`. This page is now pure
 * team metadata + internal binding.
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
      {isAdmin && <TeamIdentityPanel isFirst />}
      {isAdmin && <ContextTreeSettingsPanel />}
      <SourceReposSettingsPanel isFirst={!isAdmin} />
    </div>
  );
}
