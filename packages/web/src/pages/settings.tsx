import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { useWorkspaceViewport } from "../hooks/use-viewport.js";
import { cn } from "../lib/utils.js";

/**
 * Settings layout — sidebar + main content. Replaces the earlier double-tab
 * pattern (global nav tabs + sub-tabs) which stacked two tab visuals against
 * each other.
 *
 * Why sidebar (and not another row of tabs / flat single page)?
 *   - Settings is an *index of independent modules*, not multiple views of a
 *     single entity. Industry pattern (GitHub / Linear / Stripe / Vercel) is
 *     left sidebar for settings; top tabs for entity-detail views.
 *   - Single-page flat layout scales poorly past ~5 sections; with Billing /
 *     Security / API keys / Webhooks on the roadmap, sidebar lets the list
 *     grow without redesign.
 *
 * Width: the main column inside still respects the shared 960 canvas (see
 * `components/layout.tsx`), the sidebar is an additional 200 on the left
 * (sidebar 200 + main 960 = 1160 total).
 * Layout opts out of the default 960 wrapper via `isSettings` so this whole
 * shell can centre itself at ~1180.
 *
 * Narrow viewport (<48rem): the sidebar would steal half the screen,
 * so it collapses into a horizontally-scrollable pill bar above the
 * `<Outlet/>`. Same NavLink semantics (active state via `isActive`), same
 * route targets — only the chrome shape changes.
 *
 * Page header lives HERE, not in each sub-page. The old pattern had every
 * sub-page render its own `PageHeader` whose title just repeated the active
 * nav label (`GitHub` → `GitHub` → `GitHub Connection`) — a redundant title
 * that was also rendered *smaller* (text-subtitle) than the section headings
 * beneath it (text-title), so it never functioned as a real page title.
 * The layout now owns a single accessible `<h1>` (visually hidden — the
 * sidebar already answers "where am I") plus an optional one-line lead drawn
 * from `ITEMS[].description`. Sourcing the label from `ITEMS` is also what
 * keeps the sidebar and the heading from drifting (they used to: `Onboarding`
 * in the nav vs `Setup` as the page title). Section headings are now the top
 * visible tier on every page.
 *
 * Sub-routes:
 *   Computers     — user-scoped: machines connected to First Tree (most-frequent
 *                   entry point — placed first)
 *   Context tree  — org-scoped Context Tree binding (repo / branch). Visible
 *                   to all members (read-only); only admins can edit.
 *   Resources     — org-scoped runtime resources (prompt / skill / mcp).
 *                   Visible to all members (read-only); only admins can manage.
 *   Integrations  — Team code access plus provider-specific GitHub/GitLab
 *                   connections. Visible to all members (read-only); only
 *                   admins can mutate them.
 *   Setup         — guided-setup stepper enable/disable (hidden once
 *                   onboarding is permanently completed)
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
};

const ITEMS: Item[] = [
  { to: "/settings/computers", label: "Computers" },
  {
    to: "/settings/context",
    label: "Context tree",
    description: "The shared knowledge tree your team's agents read from.",
  },
  {
    to: "/settings/resources",
    label: "Resources",
    description: "Team defaults and opt-in resources your agents load when they start.",
  },
  {
    to: "/settings/integrations",
    label: "Integrations",
    description: "Choose the code agents can access and connect providers for events and identity.",
  },
  { to: "/settings/onboarding", label: "Setup" },
];

export function SettingsLayout() {
  const { onboardingCompletedAt, meLoaded } = useAuth();
  const viewport = useWorkspaceViewport();
  const { pathname } = useLocation();
  // Wait for `/me` to resolve before rendering the nav so role-dependent
  // entries such as Onboarding do not flicker during a fresh page load.
  if (!meLoaded) {
    return null;
  }
  // Once onboarding completes, the wizard is terminal and the entry is hidden.
  // Direct URL access to /settings/onboarding still redirects out via the page's
  // own guard.
  const hasCompletedOnboarding = onboardingCompletedAt !== null;

  const visible = ITEMS.filter((it) => {
    if (it.to === "/settings/onboarding" && hasCompletedOnboarding) return false;
    return true;
  });

  // The active sub-route drives the single page `<h1>` (visually hidden) and
  // the optional lead. Match the longest `to` that prefixes the pathname so a
  // future nested route (e.g. /settings/resources/:id) still resolves to its
  // section header.
  const activeItem =
    [...ITEMS].sort((a, b) => b.to.length - a.to.length).find((it) => pathname.startsWith(it.to)) ?? ITEMS[0];

  if (viewport === "narrow") {
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
          {visible.map((item) => (
            <PillLink key={item.to} to={item.to} label={item.label} />
          ))}
        </nav>
        <div className="flex-1 min-w-0">
          <SettingsHeader item={activeItem} />
          <Outlet />
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
          {visible.map((item) => (
            <SidebarLink key={item.to} to={item.to} label={item.label} />
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0">
        <SettingsHeader item={activeItem} />
        <Outlet />
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
  if (!item) return null;
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

function SidebarLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={cn(
        "block text-body transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {({ isActive }) => (
        <span
          className={cn("block", isActive && "font-medium")}
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            borderRadius: "var(--radius-input)",
            color: isActive ? "var(--fg)" : "var(--fg-3)",
            background: isActive ? "var(--bg-hover)" : "transparent",
          }}
        >
          {label}
        </span>
      )}
    </NavLink>
  );
}

function PillLink({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={cn(
        "shrink-0 text-body transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {({ isActive }) => (
        <span
          className={cn("inline-block whitespace-nowrap", isActive && "font-medium")}
          style={{
            padding: "var(--sp-1_5) var(--sp-3)",
            borderRadius: "var(--radius-input)",
            color: isActive ? "var(--fg)" : "var(--fg-3)",
            background: isActive ? "var(--bg-hover)" : "transparent",
          }}
        >
          {label}
        </span>
      )}
    </NavLink>
  );
}
