import { useAuth } from "../auth/auth-context.js";
import { ContextTreeSettingsPanel } from "./context-tree-settings-panel.js";
import { GithubIntegrationPanel } from "./github-integration-panel.js";
import { SourceReposSettingsPanel } from "./source-repos-settings-panel.js";
import { TeamIdentityPanel } from "./team-identity-panel.js";

/**
 * Per-org settings page (Team → Team Settings).
 *
 * Admin sees four panels:
 *   1. TeamIdentityPanel — display name + short identifier
 *   2. ContextTreeSettingsPanel — per-org Context Tree binding
 *   3. SourceReposSettingsPanel — team-level list of bound source repos
 *   4. GithubIntegrationPanel — per-org GitHub webhook URL + secret
 *
 * Members see only `SourceReposSettingsPanel` (read-only). The
 * `source_repos` namespace sets `readPolicy: "member"` server-side, so
 * a member can GET the list but cannot mutate it. The other three panels
 * stay admin-only — their APIs are admin-gated for write, and rendering
 * an empty form to a non-admin is more confusing than helpful.
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
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-4)" }}>
      {isAdmin && <TeamIdentityPanel />}
      {isAdmin && <ContextTreeSettingsPanel />}
      <SourceReposSettingsPanel />
      {isAdmin && <GithubIntegrationPanel />}
    </div>
  );
}
