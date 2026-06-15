import type { OrgBrief } from "@first-tree/shared";
import { useMemo, useState } from "react";
import { api } from "../api/client.js";
import { AuthContext } from "../auth/auth-context.js";
import { UserMenu } from "../components/user-menu.js";

/**
 * DEV-only visual preview of the user menu's team list, mounted at
 * `/preview/user-menu` (gated by `import.meta.env.DEV` in app.tsx).
 *
 * Renders the REAL `UserMenu` against a 8-org fixture so the two behaviours
 * under review are demoable without a backend or login:
 *   - the current team is always pinned as the first row, and
 *   - lists longer than 5 collapse behind "View N more teams".
 *
 * Switching teams in the preview updates the faked auth `organizationId`
 * in-place and then REJECTS — `switchOrg`'s catch branch keeps the menu
 * open and skips its `navigate("/")` (react-router forbids nesting a
 * MemoryRouter here), so the re-pinned order is visible immediately.
 *
 * `api.get` is patched for `/me/organizations` only while the current route
 * is `/preview/user-menu` — every other path and every non-preview route falls
 * through to the real client.
 */

const MOCK_ORGS: OrgBrief[] = [
  { id: "org-1", name: "antgroup", displayName: "antgroup", role: "member" },
  { id: "org-2", name: "gandy2025s-team", displayName: "gandy2025's team", role: "admin" },
  { id: "org-3", name: "agent-team-foundation", displayName: "agent-team-foundation", role: "admin" },
  { id: "org-4", name: "first-tree-qa", displayName: "first-tree-qa", role: "member" },
  { id: "org-5", name: "hearback", displayName: "hearback", role: "admin" },
  { id: "org-6", name: "kael-labs", displayName: "kael-labs", role: "member" },
  { id: "org-7", name: "weekend-hacks", displayName: "weekend-hacks", role: "member" },
  { id: "org-8", name: "design-playground", displayName: "design-playground", role: "member" },
];

type ApiGet = typeof api.get;

declare global {
  interface Window {
    __ftUserMenuPreviewOriginalGet?: ApiGet;
  }
}

// Patch at module load so the UserMenu effect sees the mock on first render.
// The interception is path-gated and the original is stashed for HMR, matching
// the safer preview-shim pattern used by onboarding-preview.tsx.
window.__ftUserMenuPreviewOriginalGet ??= api.get;
const originalGet = window.__ftUserMenuPreviewOriginalGet;
api.get = (<T,>(path: string): Promise<T> => {
  if (window.location.pathname.startsWith("/preview/user-menu") && path === "/me/organizations") {
    // The generic API client cannot infer that this string path maps to OrgBrief[].
    return Promise.resolve(MOCK_ORGS as T);
  }
  return originalGet<T>(path);
}) as ApiGet;

export function UserMenuPreviewPage() {
  // Default to a mid-list org so the pin-to-top behaviour is visible
  // immediately (org-5 sits 5th in the raw /me/organizations order).
  const [organizationId, setOrganizationId] = useState("org-5");
  const currentRole = MOCK_ORGS.find((o) => o.id === organizationId)?.role ?? "member";

  const auth = useMemo(
    () =>
      ({
        isAuthenticated: true,
        meLoaded: true,
        organizationId,
        role: currentRole,
        user: { displayName: "Gandy", username: "gandy2025", avatarUrl: null },
        selectOrganization: async (id: string) => {
          setOrganizationId(id);
          // Reject on purpose: switchOrg's catch keeps the dropdown open and
          // skips navigate("/"), so the preview stays on this page with the
          // newly pinned order visible in place.
          throw new Error("preview: stay on page");
        },
        logout: () => undefined,
        // The remaining ~15 fields are irrelevant to UserMenu — same
        // unavoidable-cast pattern as /preview/resources.
      }) as unknown as Parameters<typeof AuthContext.Provider>[0]["value"],
    [organizationId, currentRole],
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
            /preview/user-menu — click the avatar; current team is pinned first, 8 mock teams collapse at 5
          </span>
          <UserMenu />
        </header>
        <div className="text-caption" style={{ padding: "var(--sp-4)", color: "var(--fg-3)" }}>
          <p>
            Current team:{" "}
            <strong style={{ color: "var(--fg)" }}>
              {MOCK_ORGS.find((o) => o.id === organizationId)?.displayName}
            </strong>{" "}
            (switching a team re-pins it to the top — reopen the menu to see).
          </p>
          <button
            type="button"
            className="text-caption mono"
            onClick={() => document.documentElement.classList.toggle("dark")}
            style={{
              marginTop: "var(--sp-2)",
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
