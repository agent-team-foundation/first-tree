import { NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";

/**
 * Settings is a top-tab container. It follows the same flat rhythm as
 * the agent configuration page: no secondary sidebar, one thin tab rule,
 * and each sub-route owns its compact page header + sections.
 *
 * Sub-tabs:
 *   Team           — org-scoped Identity / Context Tree / Source repos
 *                    (Source repos read-only for members; the rest are
 *                    admin-only and hidden from member's view of the page)
 *   Computers      — user-scoped: machines connected to Hub
 *   GitHub         — admin-only: webhook URL + secret for routing GitHub
 *                    issue / comment events to agents
 *   Messaging      — IM bridges (Feishu / Slack adapter CRUD)
 *   Onboarding     — guided-setup stepper enable / disable
 *
 * `GitHub` is hidden from the member tab bar because both reads and writes
 * are admin-gated server-side — surfacing the entry would just lead to a
 * 403 inside.
 */
export function SettingsLayout() {
  const { role, onboardingCompletedAt, meLoaded } = useAuth();
  // Wait for `/me` to resolve before rendering the nav — otherwise a fresh
  // direct hit on /settings/github would briefly paint the member-view tab
  // set (no GitHub, plus Onboarding) before `role` flips to "admin". The
  // sidebar-era variant tolerated that flash visually; the top-tab variant
  // makes it obvious.
  if (!meLoaded) {
    return null;
  }
  const isAdmin = role === "admin";
  // Once Step 3 succeeds (`onboarding_completed_at` stamped), the wizard
  // is a terminal — subsequent tree / source-repo edits live in Settings →
  // Team and /agents/:uuid, not back inside the onboarding flow. Hiding
  // the sidebar entry is the gate; /settings/onboarding itself also
  // redirects to /settings/team for direct URL access.
  const hasCompletedOnboarding = onboardingCompletedAt !== null;

  return (
    <div className="-m-6 flex flex-col" style={{ minHeight: "calc(100vh - var(--sp-10))" }}>
      <nav
        aria-label="Settings"
        className="flex items-end overflow-x-auto"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          gap: 2,
          height: 34,
          padding: "0 var(--sp-5)",
          background: "var(--bg-raised)",
          borderBottom: "var(--hairline) solid var(--border)",
        }}
      >
        <SubNavLink to="/settings/team" label="Team" />
        <SubNavLink to="/settings/computers" label="Computers" />
        {isAdmin && <SubNavLink to="/settings/github" label="GitHub" />}
        <SubNavLink to="/settings/integrations" label="Messaging" />
        {!hasCompletedOnboarding && <SubNavLink to="/settings/onboarding" label="Onboarding" />}
      </nav>

      <div className="flex-1 min-w-0">
        <Outlet />
      </div>
    </div>
  );
}

function SubNavLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={cn(
        "inline-flex items-center bg-transparent text-body font-medium",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {({ isActive }) => (
        <span
          className={cn(
            "inline-flex items-center whitespace-nowrap transition-colors",
            isActive ? "text-[var(--fg)]" : "text-[var(--fg-3)] hover:text-[var(--fg)]",
          )}
          style={{
            padding: "var(--sp-1_75) var(--sp-3)",
            marginBottom: -1,
            borderBottom: `var(--hairline-bold) solid ${isActive ? "var(--accent)" : "transparent"}`,
          }}
        >
          {label}
        </span>
      )}
    </NavLink>
  );
}
