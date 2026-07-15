import { NavLink, Outlet } from "react-router";
import { cn } from "../../lib/utils.js";

const PROVIDERS = [
  { to: "/settings/integrations/github", label: "GitHub" },
  { to: "/settings/integrations/gitlab", label: "GitLab" },
] as const;

/** One Settings information architecture; providers are children of Integrations. */
export function SettingsIntegrationsLayout() {
  return (
    <div>
      <nav
        aria-label="Integration provider"
        className="flex"
        style={{ gap: "var(--sp-1)", padding: "var(--sp-2) var(--sp-5) 0" }}
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
