import { useAuth } from "../../auth/auth-context.js";
import { ContextTreeSettingsPanel } from "../context-tree-settings-panel.js";

/**
 * Settings → Context tree. The per-org Context Tree binding (repo / branch).
 *
 * Visible to all members, not just admins: the `context_tree` org-settings
 * namespace is `readPolicy: "member"`, so members can GET the binding to see
 * which tree their agents read from. Only admins can edit it (PUT/DELETE are
 * admin-gated server-side), so the panel renders a read-only form for members.
 * That's why this page does NOT redirect non-admins.
 *
 * Named "Context tree" (not just "Context") to distinguish it from the
 * top-level Context page, which browses tree *contents* — this page configures
 * the *binding*.
 */
export function SettingsContextTreePage() {
  const { role } = useAuth();

  if (role === null) {
    return (
      <div className="text-body" style={{ padding: "var(--sp-5)", color: "var(--fg-3)" }}>
        Loading...
      </div>
    );
  }

  // Page heading + lead are owned by the Settings layout (see settings.tsx).
  return (
    <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
      <ContextTreeSettingsPanel />
    </div>
  );
}
