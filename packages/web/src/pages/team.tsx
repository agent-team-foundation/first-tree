import { NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";

/**
 * Team layout. Non-admin users land directly on the team roster (no
 * sidebar — only one item would be visible). Admin users see a sidebar
 * with `Roster` and `Settings` so the admin-only configuration page
 * stays a peer to the roster rather than buried in a header button.
 */
export function TeamLayout() {
  const { role } = useAuth();

  // Until role hydrates, render the bare Outlet so the page itself shows
  // immediately. Admin sidebar appears once we know the user is admin —
  // briefly missing for an admin during hydration is far less jarring than
  // a wrong sidebar showing up for a non-admin.
  if (role !== "admin") {
    return <Outlet />;
  }

  return (
    <div className="-m-6 flex" style={{ minHeight: "calc(100vh - var(--sp-10))" }}>
      <aside
        className="shrink-0 overflow-auto"
        style={{
          width: 200,
          padding: "var(--sp-4) var(--sp-2)",
        }}
      >
        <SubNavLink to="/team" end label="Members" />
        <SubNavLink to="/team/settings" label="Team settings" />
      </aside>

      <div className="flex-1 min-w-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

function SubNavLink({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "block w-full text-left bg-transparent text-body transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          !isActive && "hover:bg-accent",
        )
      }
      style={{ borderRadius: "var(--radius-input)" }}
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
