import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { cn } from "../../lib/utils.js";
import { ResourceTypeSections } from "./resource-sections.js";

const PROVIDERS = [
  { to: "/settings/integrations/github", label: "GitHub" },
  { to: "/settings/integrations/gitlab", label: "GitLab" },
] as const;

/**
 * One Settings information architecture: provider-neutral code access first,
 * then provider-specific event/identity connections. Repositories deliberately
 * sit outside the provider tabs because their runtime availability does not
 * depend on a GitHub App or GitLab webhook connection.
 */
export function SettingsIntegrationsLayout() {
  const location = useLocation();
  const codeAccessRef = useRef<HTMLElement>(null);

  // React Router updates the URL fragment but does not scroll the app's
  // persistent overflow container. Position and focus the shared section
  // explicitly so exits from a deeply scrolled Agent page cannot land below
  // the intended destination.
  useEffect(() => {
    if (location.hash !== "#code-access") return;
    const target = codeAccessRef.current;
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [location.hash]);

  return (
    <div>
      <section
        ref={codeAccessRef}
        id="code-access"
        tabIndex={-1}
        aria-label="Code available to agents"
        style={{ padding: "var(--sp-2) var(--sp-5) 0", scrollMarginTop: "var(--sp-4)" }}
      >
        <ResourceTypeSections
          types={["repo"]}
          titleFor={() => "Code available to agents"}
          descriptionFor={() =>
            "Choose the code your agents can read and change. GitHub, GitLab, or any Git server; private access uses Git credentials on each agent's computer."
          }
          addLabelFor={() => "Add code repository"}
          emptyLabelFor={() => "No code repositories configured yet."}
          compactLimit={3}
        />
      </section>

      <div style={{ padding: "var(--sp-7) var(--sp-5) 0" }}>
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
