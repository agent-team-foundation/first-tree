import type { OrgBrief } from "@first-tree/shared";
import { useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { AuthContext } from "../auth/auth-context.js";
import { TeamSwitchOverlay } from "../components/team-switch-overlay.js";
import { TeamSwitcher } from "../components/team-switcher.js";

/**
 * DEV-only visual preview of the header team switcher, mounted at
 * `/preview/team-switcher` (gated by `import.meta.env.DEV` in app.tsx).
 *
 * Renders the REAL `TeamSwitcher` + `TeamSwitchOverlay` against an 8-org
 * fixture under a faked auth context, so every state under review is demoable
 * without a backend or login:
 *   - multi-team menu (current-team header + scrollable "other teams" list),
 *   - the in-flight switch (row spinner + disabled list + optimistic anchor +
 *     "Switching to {name}…" veil) via a deliberately slow `selectOrganization`,
 *   - the failure path (rollback + inline "Couldn't switch" + menu stays open)
 *     via the "force failure" toggle, and
 *   - the single-team degrade (anchor stays, no switch list) via the toggle.
 *
 * `TeamSwitcher` gets `redirectHomeOnSwitch={false}` so a successful switch
 * stays on this page (react-router forbids nesting a router to absorb the
 * production `navigate("/")`).
 */

// Extracted so it can double as the provably-defined fallback below (the index
// `MOCK_ORGS[0]` is `OrgBrief | undefined` under noUncheckedIndexedAccess).
const FALLBACK_ORG: OrgBrief = { id: "org-1", name: "acme-robotics", displayName: "Acme Robotics", role: "admin" };

const MOCK_ORGS: OrgBrief[] = [
  FALLBACK_ORG,
  { id: "org-2", name: "globex", displayName: "Globex", role: "member" },
  { id: "org-3", name: "initech", displayName: "Initech", role: "member" },
  { id: "org-4", name: "umbrella-corp", displayName: "Umbrella Corp", role: "member" },
  { id: "org-5", name: "wayne-enterprises", displayName: "Wayne Enterprises", role: "admin" },
  { id: "org-6", name: "stark-industries", displayName: "Stark Industries", role: "member" },
  { id: "org-7", name: "cyberdyne", displayName: "Cyberdyne", role: "member" },
  { id: "org-8", name: "tyrell-corp", displayName: "Tyrell Corp", role: "admin" },
];

type ApiGet = typeof api.get;

declare global {
  interface Window {
    __ftTeamSwitcherPreviewOriginalGet?: ApiGet;
  }
}

// Single-team toggle: read by the path-gated `/me/organizations` patch below.
// Assigned during render (not in an effect) so the value is current before the
// remounted TeamSwitcher's fetch effect — child effects run before parent
// effects, so an effect-set flag would lag a frame behind the remount.
let previewSingle = false;

// Patch at module load so the TeamSwitcher effect sees the mock on first render.
// Path-gated and HMR-safe — matches the user-menu / onboarding preview shims.
window.__ftTeamSwitcherPreviewOriginalGet ??= api.get;
const originalGet = window.__ftTeamSwitcherPreviewOriginalGet;
api.get = (<T,>(path: string): Promise<T> => {
  if (window.location.pathname.startsWith("/preview/team-switcher") && path === "/me/organizations") {
    // The generic API client cannot infer this string path maps to OrgBrief[].
    const list = previewSingle ? MOCK_ORGS.slice(0, 1) : MOCK_ORGS;
    return Promise.resolve(list as T);
  }
  return originalGet<T>(path);
}) as ApiGet;

export function TeamSwitcherPreviewPage() {
  const [organizationId, setOrganizationId] = useState("org-1");
  const [switchingOrg, setSwitchingOrg] = useState<OrgBrief | null>(null);
  const [single, setSingle] = useState(false);
  const [forceFail, setForceFail] = useState(false);
  // Render the icon-only anchor variant the header falls back to on narrow.
  const [compact, setCompact] = useState(false);
  // Read synchronously inside the async `selectOrganization`, so toggling
  // "force failure" mid-session takes effect without re-creating the auth value.
  const forceFailRef = useRef(forceFail);
  forceFailRef.current = forceFail;
  // Sync the module flag before children render/fetch (see note above).
  previewSingle = single;

  const currentOrg = MOCK_ORGS.find((o) => o.id === organizationId) ?? FALLBACK_ORG;

  const auth = useMemo(
    () =>
      ({
        isAuthenticated: true,
        meLoaded: true,
        organizationId,
        role: currentOrg.role,
        teamDisplayName: currentOrg.displayName,
        user: { id: "user-self", displayName: "Gandy", username: "gandy2025", avatarUrl: null },
        switchingOrg,
        setSwitchingOrg,
        selectOrganization: async (id: string) => {
          // Deliberately slow so the in-flight visuals (spinner, disabled list,
          // optimistic anchor, veil) are observable; the real one is fast.
          await new Promise((resolve) => window.setTimeout(resolve, 700));
          if (forceFailRef.current) throw new Error("preview: forced switch failure");
          setOrganizationId(id);
        },
        logout: () => undefined,
        // The remaining auth fields are irrelevant to the switcher — same
        // unavoidable-cast pattern as /preview/user-menu.
      }) as unknown as Parameters<typeof AuthContext.Provider>[0]["value"],
    [organizationId, currentOrg.role, currentOrg.displayName, switchingOrg],
  );

  return (
    <AuthContext.Provider value={auth}>
      <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
        {/* Mock header — anchor sits header-left, account avatar would be right. */}
        <header
          className="flex items-center"
          style={{
            height: 48,
            gap: "var(--sp-3_5)",
            padding: "0 var(--sp-3)",
            borderBottom: "var(--hairline) solid var(--border)",
            background: "var(--bg-raised)",
          }}
        >
          <span className="text-title" style={{ color: "var(--fg)" }}>
            First Tree
          </span>
          <span aria-hidden style={{ width: 1, height: 18, background: "var(--border)", flexShrink: 0 }} />
          {/* key remounts the switcher when the single-team fixture flips, so it
              re-fetches the filtered org list. */}
          <TeamSwitcher
            key={single ? "single" : "multi"}
            variant={compact ? "compact" : "full"}
            redirectHomeOnSwitch={false}
          />
        </header>

        {/* Mock content so the transition veil has something to dim. */}
        <div style={{ padding: "var(--sp-4)" }}>
          <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
            {["team standup", "release checklist", "context tree review", "onboarding polish"].map((title) => (
              <div key={title} className="flex items-center" style={{ gap: "var(--sp-2_5)" }}>
                <div
                  style={{
                    width: 30,
                    height: 30,
                    flex: "none",
                    borderRadius: "var(--radius-full)",
                    background: "var(--bg-sunken)",
                  }}
                />
                <div className="text-subtitle" style={{ color: "var(--fg)" }}>
                  {title}
                </div>
              </div>
            ))}
          </div>

          {/* Preview controls */}
          <div className="flex items-center" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-5)", flexWrap: "wrap" }}>
            <PreviewToggle on={single} label="Single team" onClick={() => setSingle((v) => !v)} />
            <PreviewToggle on={forceFail} label="Force switch failure" onClick={() => setForceFail((v) => !v)} />
            <PreviewToggle on={compact} label="Compact anchor (narrow)" onClick={() => setCompact((v) => !v)} />
            <PreviewToggle on={false} label="Theme" onClick={() => document.documentElement.classList.toggle("dark")} />
          </div>
          <p className="text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-3)" }}>
            Open the anchor and pick a team — watch the row spinner, disabled list, optimistic anchor, and the
            "Switching to…" veil (~0.7s here). "Force switch failure" rolls back with an inline retry hint; "Single
            team" drops the switch list but keeps the anchor.
          </p>
        </div>
      </div>

      <TeamSwitchOverlay />
    </AuthContext.Provider>
  );
}

function PreviewToggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-label"
      style={{
        padding: "var(--sp-1_5) var(--sp-3)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-input)",
        background: on ? "var(--fg)" : "var(--bg-raised)",
        color: on ? "var(--bg)" : "var(--fg-2)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
