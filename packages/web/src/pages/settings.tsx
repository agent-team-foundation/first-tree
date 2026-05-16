import { NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { PageHeader } from "../components/ui/page-header.js";
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
    return <div className="-m-6" style={{ minHeight: "calc(100vh - var(--sp-10))" }} />;
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
      <PageHeader title="Settings" subtitle="Team controls, connected computers, GitHub, and messaging bridges" />
      <nav
        aria-label="Settings"
        className="flex items-end gap-1 overflow-x-auto"
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          padding: "0 var(--sp-5)",
          background: "var(--bg)",
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
      className={({ isActive }) =>
        cn(
          "inline-flex items-center bg-transparent text-body transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          !isActive && "hover:bg-accent",
        )
      }
    >
      {({ isActive }) => (
        <span
          className="inline-flex items-center whitespace-nowrap"
          style={{
            padding: "var(--sp-2_5) var(--sp-3)",
            borderBottom: `var(--hairline-bold) solid ${isActive ? "var(--accent)" : "transparent"}`,
            color: isActive ? "var(--fg)" : "var(--fg-3)",
            fontWeight: isActive ? 500 : 400,
          }}
        >
          {label}
        </span>
      )}
    </NavLink>
  );
}
