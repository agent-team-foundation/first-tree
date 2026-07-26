import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { cn } from "../../lib/utils.js";

const PROVIDERS = [
  { to: "/settings/integrations/github", label: "GitHub" },
  { to: "/settings/integrations/gitlab", label: "GitLab" },
] as const;

/**
 * Provider-specific event, identity, and webhook connections. Team code
 * resources live on Settings → Repositories because runtime clone access does
 * not depend on either provider connection.
 */
export function SettingsIntegrationsLayout() {
  const location = useLocation();

  // Preserve deep links created while Team code access lived above the
  // provider tabs. The Repositories page owns the new focus/scroll contract.
  if (location.hash === "#code-access") {
    return <Navigate to="/settings/repositories#code-repositories" replace />;
  }

  return (
    <div>
      <div style={{ padding: "var(--sp-2) var(--sp-5) 0" }}>
        <h2 className="text-title font-semibold m-0" style={{ color: "var(--fg)" }}>
          Connections
        </h2>
        <p className="text-label m-0" style={{ color: "var(--fg-3)", marginTop: "var(--sp-0_5)" }}>
          Connect providers for webhooks, identity, and event routing.
        </p>
      </div>
      <nav
        aria-label="Connection provider"
        className="flex"
        style={{ gap: "var(--sp-1)", padding: "var(--sp-3) var(--sp-5) 0", overflowX: "auto" }}
      >
        {PROVIDERS.map((provider) => (
          <NavLink
            key={provider.to}
            to={provider.to}
            className={({ isActive }) =>
              cn(
                "text-body rounded-[var(--radius-input)] px-3 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                isActive ? "font-medium bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent",
              )
            }
          >
            {provider.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
