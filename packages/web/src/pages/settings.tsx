import { NavLink, Outlet } from "react-router";
import { cn } from "../lib/utils.js";

/**
 * Settings is a master-detail container. Flat aesthetic — no borders, no
 * contrasting sidebar bg; active state is a soft pill.
 *
 * `Team` is the org-scoped panel collection (Identity / Context Tree /
 * Source repos / GitHub integration) — written-side admin-only, with
 * `Source repos` readable by members. The other entries are user-scoped.
 */
export function SettingsLayout() {
  return (
    <div className="-m-6 flex" style={{ minHeight: "calc(100vh - var(--sp-10))" }}>
      <aside
        className="shrink-0 overflow-auto"
        style={{
          width: 200,
          padding: "var(--sp-4) var(--sp-2)",
        }}
      >
        <SubNavLink to="/settings/team" label="Team" />
        <SubNavLink to="/settings/computers" label="Computers" />
        <SubNavLink to="/settings/integrations" label="Integrations" />
        <SubNavLink to="/settings/onboarding" label="Onboarding" />
      </aside>

      <div className="flex-1 min-w-0 overflow-auto">
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
          "block w-full text-left bg-transparent text-body transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          !isActive && "hover:bg-accent",
        )
      }
      style={{
        borderRadius: "var(--radius-input)",
      }}
    >
      {({ isActive }) => (
        <span
          className="flex items-center"
          style={{
            padding: "var(--sp-1_25) var(--sp-2_5)",
            background: isActive ? "var(--bg-active)" : "transparent",
            color: isActive ? "var(--fg)" : "var(--fg-3)",
            fontWeight: isActive ? 500 : 400,
            borderRadius: "var(--radius-input)",
          }}
        >
          <span className="flex-1 truncate">{label}</span>
        </span>
      )}
    </NavLink>
  );
}
