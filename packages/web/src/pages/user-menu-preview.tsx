import { useMemo } from "react";
import { AuthContext } from "../auth/auth-context.js";
import { UserMenu } from "../components/user-menu.js";

/**
 * DEV-only visual preview of the account menu, mounted at `/preview/user-menu`
 * (gated by `import.meta.env.DEV` in app.tsx).
 *
 * Renders the REAL `UserMenu` — now account-only (user header, Account
 * settings, and Sign out) — under a faked auth context, no backend or login
 * needed. Team switching and team management moved to the header-left
 * switcher; see `/preview/team-switcher`.
 */
export function UserMenuPreviewPage() {
  const auth = useMemo(
    () =>
      ({
        isAuthenticated: true,
        meLoaded: true,
        user: { id: "user-self", displayName: "Gandy", username: "gandy2025", avatarUrl: null },
        logout: () => undefined,
        // The remaining auth fields are irrelevant to the account menu — same
        // unavoidable-cast pattern as /preview/resources.
      }) as unknown as Parameters<typeof AuthContext.Provider>[0]["value"],
    [],
  );

  return (
    <AuthContext.Provider value={auth}>
      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        <header
          className="flex items-center justify-between"
          style={{
            padding: "var(--sp-2) var(--sp-4)",
            borderBottom: "var(--hairline) solid var(--border)",
            background: "var(--bg-raised)",
          }}
        >
          <span className="text-label" style={{ color: "var(--fg-2)" }}>
            /preview/user-menu — account menu (team switching lives at /preview/team-switcher)
          </span>
          <UserMenu />
        </header>
        <div className="text-caption" style={{ padding: "var(--sp-4)", color: "var(--fg-3)" }}>
          <button
            type="button"
            className="text-caption mono"
            onClick={() => document.documentElement.classList.toggle("dark")}
            style={{
              padding: "var(--sp-1) var(--sp-2_5)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-raised)",
              color: "var(--fg-2)",
              cursor: "pointer",
            }}
          >
            theme
          </button>
        </div>
      </div>
    </AuthContext.Provider>
  );
}
