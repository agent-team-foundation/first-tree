import type { ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { useWorkspaceViewport } from "../hooks/use-viewport.js";
import { cn } from "../lib/utils.js";

/**
 * Settings layout — a flat desktop sidebar plus the active module.
 *
 * Desktop deliberately has no Personal / Team headings. Setup is a permanent
 * overview of the current member's access plus team capabilities, so it sits
 * immediately after Account and remains visible after first-run onboarding is
 * complete. The narrow pill navigation keeps its existing scope grouping;
 * mobile Settings is outside this desktop IA change.
 */

type Item = {
  to: string;
  label: string;
  /**
   * Optional one-line lead rendered under the (visually-hidden) page heading.
   * Present only where it adds context the sidebar label can't: Computers and
   * Setup restate their own label ("Machines connected to First Tree"), so
   * they carry no description.
   */
  description?: string;
  /** The page renders its own visible title and team/role context. */
  ownsHeader?: boolean;
};

type ItemGroup = {
  label: string;
  items: Item[];
};

const ACCOUNT_ITEM: Item = {
  to: "/settings/account",
  label: "Account",
  description: "Manage your profile and sign-in methods. These settings follow you across all your teams.",
};
const SETUP_ITEM: Item = { to: "/settings/setup", label: "Setup", ownsHeader: true };
const COMPUTERS_ITEM: Item = { to: "/settings/computers", label: "Computers" };
const REPOSITORIES_ITEM: Item = {
  to: "/settings/repositories",
  label: "Repositories",
  description: "Manage code available to agents and the repository backing your team's Context Tree.",
};
const RESOURCES_ITEM: Item = {
  to: "/settings/resources",
  label: "Resources",
  description: "Team defaults and opt-in resources your agents load when they start.",
};
const INTEGRATIONS_ITEM: Item = {
  to: "/settings/integrations",
  label: "Integrations",
  description: "Connect providers for webhooks, identity, and event routing.",
};
const ITEMS: Item[] = [ACCOUNT_ITEM, SETUP_ITEM, COMPUTERS_ITEM, REPOSITORIES_ITEM, RESOURCES_ITEM, INTEGRATIONS_ITEM];

// Preserve the existing narrow Settings IA; only desktop removes visible
// scope groups. Every link still uses the canonical Setup route.
const NARROW_GROUPS: ItemGroup[] = [
  {
    label: "Personal",
    items: [ACCOUNT_ITEM, COMPUTERS_ITEM],
  },
  {
    label: "Team",
    items: [REPOSITORIES_ITEM, RESOURCES_ITEM, INTEGRATIONS_ITEM, SETUP_ITEM],
  },
];

export function SettingsLayout({ activePathname, children }: { activePathname?: string; children?: ReactNode } = {}) {
  const { meLoaded, onboardingCompletedAt } = useAuth();
  const viewport = useWorkspaceViewport();
  const { pathname: routePathname } = useLocation();
  // DEV preview galleries render this real layout below their own route. Let
  // those galleries supply the path whose heading/nav state they are showing;
  // production always follows the actual router location.
  const pathname = activePathname ?? routePathname;
  // Wait for `/me` to resolve so team-aware Settings content does not flicker
  // during a fresh page load.
  if (!meLoaded) {
    return null;
  }

  // The active sub-route drives the single page `<h1>` (visually hidden) and
  // the optional lead. Match the longest `to` that prefixes the pathname so a
  // future nested route (e.g. /settings/resources/:id) still resolves to its
  // section header.
  const activeItem =
    [...ITEMS].sort((a, b) => b.to.length - a.to.length).find((it) => pathname.startsWith(it.to)) ?? ITEMS[0];

  if (viewport === "narrow") {
    // Mobile Settings is outside this desktop IA change. Preserve its existing
    // one-shot Setup visibility while pointing incomplete users at the new
    // canonical route.
    const visibleNarrowGroups = NARROW_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item !== SETUP_ITEM || onboardingCompletedAt === null),
    })).filter((group) => group.items.length > 0);

    return (
      <div className="flex flex-col" style={{ minHeight: "100%" }}>
        <nav
          aria-label="Settings"
          // Pill row is non-sticky on purpose: settings is a low-frequency
          // switch scenario (users come here to do one thing, not to bounce
          // between sub-pages). Letting the row scroll away with the content
          // gives the sub-page itself the full vertical space below the
          // Layout's already-permanent top nav. Horizontal scroll inside
          // keeps the row one line even when all the items wouldn't fit on
          // the narrowest phone.
          className="flex shrink-0"
          style={{
            gap: "var(--sp-1)",
            padding: "var(--sp-2) var(--sp-3)",
            borderBottom: "var(--hairline) solid var(--border)",
            background: "var(--bg)",
            overflowX: "auto",
          }}
        >
          {visibleNarrowGroups.map((group) => (
            <div key={group.label} className="flex shrink-0 items-center" style={{ gap: "var(--sp-1)" }}>
              <span className="text-eyebrow shrink-0" style={{ color: "var(--fg-4)", padding: "0 var(--sp-1)" }}>
                {group.label.toUpperCase()}
              </span>
              {group.items.map((item) => (
                <PillLink
                  key={item.to}
                  to={item.to}
                  label={item.label}
                  activeOverride={activePathname === undefined ? undefined : pathname.startsWith(item.to)}
                />
              ))}
            </div>
          ))}
        </nav>
        <div className="flex-1 min-w-0">
          <SettingsHeader item={activeItem} />
          {children ?? <Outlet />}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex" style={{ maxWidth: 1160, minHeight: "100%" }}>
      <aside
        aria-label="Settings"
        style={{
          width: 200,
          flexShrink: 0,
          padding: "var(--sp-3) var(--sp-3) var(--sp-4) var(--sp-1)",
          borderRight: "var(--hairline) solid var(--border)",
          position: "sticky",
          top: 0,
          alignSelf: "flex-start",
          maxHeight: "100vh",
          overflowY: "auto",
        }}
      >
        <nav className="flex flex-col" style={{ gap: "var(--sp-0_5)" }}>
          {ITEMS.map((item) => (
            <SidebarLink
              key={item.to}
              to={item.to}
              label={item.label}
              activeOverride={activePathname === undefined ? undefined : pathname.startsWith(item.to)}
            />
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0">
        <SettingsHeader item={activeItem} />
        {children ?? <Outlet />}
      </div>
    </div>
  );
}

/**
 * Single per-page header owned by the layout. The `<h1>` is visually hidden
 * (`sr-only`) — it exists for the document outline / screen readers, but the
 * sidebar already tells a sighted user where they are, so a repeated visible
 * title would be redundant chrome (and used to render smaller than the section
 * titles below it). When the active item carries a `description`, it renders as
 * a quiet one-line lead above the sub-page content.
 */
function SettingsHeader({ item }: { item: Item | undefined }) {
  if (!item || item.ownsHeader) return null;
  return (
    <>
      <h1 className="sr-only">{item.label}</h1>
      {item.description && (
        <p
          className="text-body"
          style={{ margin: 0, color: "var(--fg-3)", padding: "var(--sp-4) var(--sp-5) var(--sp-1)" }}
        >
          {item.description}
        </p>
      )}
    </>
  );
}

function SidebarLink({ to, label, activeOverride }: { to: string; label: string; activeOverride?: boolean }) {
  return (
    <NavLink
      to={to}
      className={cn(
        "block text-body transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {({ isActive }) => {
        const active = activeOverride ?? isActive;
        return (
          <span
            className={cn("block", active && "font-medium")}
            style={{
              padding: "var(--sp-2) var(--sp-3)",
              borderRadius: "var(--radius-input)",
              color: active ? "var(--fg)" : "var(--fg-3)",
              background: active ? "var(--bg-hover)" : "transparent",
            }}
          >
            {label}
          </span>
        );
      }}
    </NavLink>
  );
}

function PillLink({ to, label, activeOverride }: { to: string; label: string; activeOverride?: boolean }) {
  return (
    <NavLink
      to={to}
      className={cn(
        "shrink-0 text-body transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {({ isActive }) => {
        const active = activeOverride ?? isActive;
        return (
          <span
            className={cn("inline-block whitespace-nowrap", active && "font-medium")}
            style={{
              padding: "var(--sp-1_5) var(--sp-3)",
              borderRadius: "var(--radius-input)",
              color: active ? "var(--fg)" : "var(--fg-3)",
              background: active ? "var(--bg-hover)" : "transparent",
            }}
          >
            {label}
          </span>
        );
      }}
    </NavLink>
  );
}
