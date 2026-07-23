import { ArrowRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { useNewVersionAvailable } from "../hooks/use-version-check.js";
import { useWorkspaceViewport } from "../hooks/use-viewport.js";
import { cn } from "../lib/utils.js";
import { isLandingTrialSurface } from "../pages/quickstart/route.js";
import { CommandPalette } from "../pages/workspace/palette/command-palette.js";
import { DisconnectChip } from "./disconnect-chip.js";
import { FirstTreeLogo } from "./first-tree-logo.js";
import { NewVersionChip } from "./new-version-chip.js";
import { SupportMenu } from "./support-menu.js";
import { TeamSwitchOverlay } from "./team-switch-overlay.js";
import { TeamSwitcher } from "./team-switcher.js";
import { Button } from "./ui/button.js";
import { ThemeToggle } from "./ui/theme-toggle.js";
import { UserMenu } from "./user-menu.js";

const navTabs = [
  { to: "/", label: "Workspace", end: true },
  { to: "/context", label: "Context", end: false },
  { to: "/team", label: "Team", end: false },
  { to: "/settings", label: "Settings", end: false },
];

// Parent brand site. The dashboard is the cloud / collaboration layer of First
// Tree, so the header brand links out to the marketing site. Naming mirrors the
// landing `footer.tsx` constant of the same value. Opens in a new tab so the
// click never interrupts the user's in-app work.
const PARENT_URL = "https://first-tree.ai";

export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { organizationId } = useAuth();
  const location = useLocation();
  // Landing-campaign trial surface (`/quickstart`): render a stripped "trial
  // chrome" — brand + one conversion CTA + user menu — with none of the normal
  // workspace escape hatches (nav tabs, team switcher, command palette, rail).
  const isTrial = isLandingTrialSurface(location.pathname);

  // ⌘K / Ctrl+K to open the Jump-to palette from anywhere. Listens at
  // window-level so the shortcut survives inside textareas / editable
  // surfaces; that mirrors how Linear / GitHub / Slack treat their global
  // command palette and matches the existing "Jump to…" affordance, which
  // is the only top-bar control reachable without a click. Disabled on the
  // trial surface — the palette is an escape hatch there.
  useEffect(() => {
    if (isTrial) return;
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isTrial]);

  // The workspace shell (`WorkspaceBody`) needs the bare, full-height outlet so
  // its `flex flex-1` three-pane layout fills the viewport. `/` is the gated
  // index; `/quickstart` renders the SAME `WorkspaceBody` gate-free for the
  // landing-campaign trial, so it needs the identical outlet — not the padded
  // 960 admin canvas the `else` branch below wraps other routes in.
  const isWorkspace = location.pathname === "/" || location.pathname === "/quickstart";
  // Settings owns its own two-column (sidebar + main) layout and centres a
  // ~1160 wrapper instead of the default 960 canvas — let it manage its
  // own width.
  const isSettings = location.pathname.startsWith("/settings");

  // Top-bar progressive collapse, tuned so the user menu (sign-out, org-switch)
  // is reachable at EVERY width — dropping it below `xl` previously stranded
  // every phone / tablet / sub-1280 desktop window with no way to log out.
  //   - `xl`     : brand | tabs | [status chips] [⌘K] [theme] [avatar]
  //   - `md`     : brand | tabs | [status icons] [⌘K] [theme] [avatar]
  //   - `narrow` : tabs | [status icons] [avatar]       (also drops brand)
  // On `narrow` the theme toggle and full status chips drop too: four full tabs
  // plus text chips + theme + avatar overflow a phone-width row and would clip
  // the avatar off the right edge. Phones fall back to the OS
  // `prefers-color-scheme` (honoured by the blocking theme bootstrap); the toggle returns
  // at `md`. The avatar is the one control that never drops.
  const viewport = useWorkspaceViewport();
  // Lifted out of NewVersionChip so the `/version.json` poll runs at EVERY
  // breakpoint — the full chip is dropped on `narrow`, but version detection
  // must not be. The chip is rendered in two places below: the full pill in the
  // right controls, and a compact icon-only fallback when the brand is dropped.
  const newVersionAvailable = useNewVersionAvailable();
  const showJumpButton = viewport !== "narrow";
  const showJumpLabel = viewport === "xl";
  const dropBrand = viewport === "narrow";
  const showThemeToggle = viewport !== "narrow";
  const showFullStatusChips = viewport === "xl";
  // The team anchor is reachable at every breakpoint (like the avatar). It is
  // absent only when no org is selected (mid-onboarding), where it would have
  // nothing to anchor to and Create / Join is carried by the onboarding flow.
  const showAnchor = !!organizationId;
  // Brand present → brand | tabs(center) | controls(end). Brand collapsed
  // (narrow) → [team anchor] | tabs(start) | controls(end): the anchor moves to
  // its own leading `auto` column so "which team am I in" stays reachable after
  // the brand drops. With no selected org the anchor is absent and the row falls
  // back to tabs | controls. The narrow tabs track is `minmax(0, 1fr)` (not the
  // default `minmax(auto, 1fr)`) so it can shrink below the tabs' intrinsic
  // width and let them scroll, instead of pushing the avatar past the right edge.
  const headerColumns = dropBrand ? (showAnchor ? "auto minmax(0, 1fr) auto" : "minmax(0, 1fr) auto") : "1fr auto 1fr";

  return (
    <div
      className="flex flex-col overflow-hidden"
      // Double height declaration: `100vh` ships first as the universal
      // fallback; `100dvh` overrides where supported (iOS 15.4+, Chrome
      // 108+) so the chrome stays in sync with the dynamically-resized
      // viewport when iOS Safari's URL bar / home indicator hides on
      // scroll. Without the dvh, the composer slips behind the toolbar
      // on phones.
      style={{ height: "100vh", minHeight: "100dvh", background: "var(--bg)" }}
    >
      {/* Top bar. Trial surface gets a stripped header (brand + one conversion
          CTA + user menu); everything else gets the full workspace chrome. */}
      {isTrial ? (
        <header
          className="relative shrink-0 grid items-center"
          style={{
            height: 48,
            // Centre column is `minmax(0, auto)` so the CTA can shrink (label
            // truncates) instead of overflowing the row on very narrow phones.
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr)",
            gap: "var(--sp-3)",
            padding: "0 var(--sp-3)",
            borderBottom: "var(--hairline) solid var(--border)",
            background: "var(--bg-raised)",
          }}
        >
          {/* Brand only — no team switcher (switching org is an escape hatch). */}
          <a
            href={PARENT_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="First Tree — open first-tree.ai in a new tab"
            className="flex items-center cursor-pointer"
            style={{ gap: 10, justifySelf: "start", minWidth: 0 }}
          >
            <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)", flexShrink: 0 }} />
            {!dropBrand && (
              <span className="text-title" style={{ color: "var(--fg)" }}>
                First Tree
              </span>
            )}
          </a>

          {/* The single intentional way out of the trial → standard onboarding. */}
          <Button asChild size="sm" className="min-w-0" style={{ justifySelf: "center" }}>
            <Link to="/onboarding">
              <span className="truncate">Set up First Tree{dropBrand ? "" : " for your team"}</span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </Link>
          </Button>

          {/* User menu (sign out) stays reachable at every width. */}
          <div className="flex items-center shrink-0" style={{ gap: 6, justifySelf: "end" }}>
            {showThemeToggle ? <ThemeToggle /> : null}
            <UserMenu />
          </div>
        </header>
      ) : (
        <header
          className="relative shrink-0 grid items-center"
          style={{
            height: 48,
            // 1fr auto 1fr keeps the centre column (tabs) anchored to the
            // page midpoint regardless of how the brand cluster grows. The
            // disconnect chip can appear/disappear without shifting tabs.
            // When the right controls collapse (md/narrow) we drop to
            // `1fr auto`; when the brand also collapses (narrow) we go to
            // a single column so the tabs anchor to the left edge.
            gridTemplateColumns: headerColumns,
            gap: "var(--sp-3)",
            padding: "0 var(--sp-3)",
            borderBottom: "var(--hairline) solid var(--border)",
            background: "var(--bg-raised)",
          }}
        >
          {/* Brand cluster: logo + name welded together, then the team anchor. On
            narrow the cluster is dropped, but the anchor must stay reachable —
            it surfaces icon-only in its own leading column. */}
          {dropBrand ? (
            showAnchor ? (
              <div style={{ justifySelf: "start", minWidth: 0 }}>
                <TeamSwitcher variant="compact" />
              </div>
            ) : null
          ) : (
            <div className="flex items-center" style={{ gap: "var(--sp-3_5)", justifySelf: "start", minWidth: 0 }}>
              {/* Brand links out to the parent marketing site in a new tab. */}
              <a
                href={PARENT_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="First Tree — open first-tree.ai in a new tab"
                className="flex items-center cursor-pointer"
                style={{ gap: 10, flexShrink: 0 }}
              >
                <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)" }} />
                {/* Brand uses the `text-title` token (16 / 600 / -0.2 letter-spacing). */}
                <span className="text-title" style={{ color: "var(--fg)" }}>
                  First Tree
                </span>
              </a>
              {/* Team anchor sits next to the brand (workspace identity, left side),
                separated by a hairline rule; absent when no org is selected. */}
              {showAnchor && (
                <>
                  <span aria-hidden style={{ width: 1, height: 18, background: "var(--border)", flexShrink: 0 }} />
                  <TeamSwitcher variant="full" />
                </>
              )}
            </div>
          )}

          {/* Tabs */}
          <nav
            className="flex"
            style={{
              gap: 2,
              // `pointerEvents: none` lets the centred (xl/md) nav's empty flanks
              // pass clicks through; on `narrow` the nav is a real scroll
              // container in a shrunk track, so it needs to receive touch.
              pointerEvents: dropBrand ? "auto" : "none",
              // On `narrow` the brand collapses and the tabs share the row with
              // the compact controls — anchor the tabs to the start so they sit
              // at the left edge rather than centring against the avatar.
              justifySelf: dropBrand ? "start" : "center",
              // Narrow track is `minmax(0, 1fr)`: let the row scroll horizontally
              // if the tabs can't all fit (tiny phones / long i18n labels) rather
              // than overflow and clip the avatar. No-op when the tabs fit.
              ...(dropBrand ? { minWidth: 0, width: "100%", overflowX: "auto" } : null),
            }}
          >
            {navTabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                style={{ pointerEvents: "auto" }}
                className={({ isActive }) =>
                  // `shrink-0` keeps each tab its natural width inside the narrow
                  // scrollable nav, so labels never compress or wrap.
                  cn("inline-flex shrink-0 items-center transition-colors", isActive ? "" : "hover:text-[var(--fg)]")
                }
              >
                {({ isActive }) => (
                  <span
                    className="inline-flex items-center text-subtitle font-medium"
                    style={{
                      padding: "var(--sp-1_5) var(--sp-3)",
                      gap: 6,
                      borderRadius: 5,
                      color: isActive ? "var(--fg)" : "var(--fg-3)",
                      background: isActive ? "var(--bg-hover)" : "transparent",
                    }}
                  >
                    {tab.label}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

          {/* Right controls. The user menu (avatar) renders at every breakpoint
            so sign-out / org-switch stay reachable on phones and tablets; the
            theme toggle and command-palette entry drop on `narrow`. Status
            stays visible at every width: full text on `xl`, compact icons
            below it so the right track cannot crowd the centred tabs. */}
          <div className="flex items-center shrink-0" style={{ gap: 6, justifySelf: "end" }}>
            {showFullStatusChips ? (
              <>
                <DisconnectChip />
                <NewVersionChip show={newVersionAvailable} />
              </>
            ) : (
              <>
                <DisconnectChip compact />
                <NewVersionChip show={newVersionAvailable} compact />
              </>
            )}
            {showJumpButton ? (
              <>
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  aria-label="Jump to… (⌘K)"
                  aria-keyshortcuts="Meta+K Control+K"
                  title="Jump to… (⌘K / Ctrl+K)"
                  className="inline-flex items-center transition-colors text-body"
                  style={{
                    gap: 7,
                    height: 30,
                    minWidth: showJumpLabel ? 112 : undefined,
                    padding: "0 var(--sp-2)",
                    color: "var(--fg-3)",
                    border: "var(--hairline) solid var(--border)",
                    borderRadius: "var(--radius-input)",
                    background: "var(--bg-sunken)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--fg)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--fg-3)";
                  }}
                >
                  <Search aria-hidden="true" size={14} style={{ flexShrink: 0 }} />
                  {showJumpLabel ? <span>Search</span> : null}
                  <span
                    aria-hidden
                    className="text-caption font-mono"
                    style={{
                      padding: "var(--sp-0_5) var(--sp-1_25)",
                      border: "var(--hairline) solid var(--border)",
                      borderRadius: "var(--radius-chip)",
                      color: "var(--fg-3)",
                      background: "var(--bg-raised)",
                    }}
                  >
                    ⌘K
                  </span>
                </button>
                <span
                  style={{
                    width: 1,
                    height: 18,
                    background: "var(--border)",
                    margin: "0 var(--sp-1)",
                  }}
                />
              </>
            ) : null}
            {showThemeToggle ? (
              <>
                {/* Support (Discord / WeChat) sits with the theme toggle: both
                    drop on `narrow`, where the row is already at capacity — a
                    stuck phone user still has the same links on the onboarding
                    finale and can reach them from a wider window. */}
                <SupportMenu />
                <ThemeToggle />
                <span
                  style={{
                    width: 1,
                    height: 18,
                    background: "var(--border)",
                    margin: "0 var(--sp-1)",
                  }}
                />
              </>
            ) : null}
            <UserMenu />
          </div>
        </header>
      )}

      {/* One intentional veil over the content while an org switch runs. */}
      <TeamSwitchOverlay />

      {/* No command palette on the trial surface (it's an escape hatch). */}
      {!isTrial && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}

      {/* Main content */}
      {isWorkspace ? (
        <Outlet />
      ) : isSettings ? (
        // Settings manages its own width: sidebar + main column (1160 total).
        // Main column inside still respects the shared 960 content width;
        // sidebar is an additional 200 on the left.
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      ) : (
        <main className="flex-1 overflow-auto">
          {/* Canvas width 960 is the single shared content width across
              Context / Team / Agent Detail. Chosen as the comfortable upper
              bound for configuration- and editing-heavy admin pages (GitHub
              uses ~896, Vercel ~880, Linear ~960). Below the lg breakpoint
              padding tightens so 960 + p-6 = 1008 logical units doesn't
              force a horizontal scrollbar on smaller viewports. The Team
              table's column widths sum to ~870 — at viewports narrower than
              ~810 the table overflows into main's own scroll; that's the
              standard "wide table → local horizontal scroll" pattern
              (GitHub, Stripe both do this), and the page chrome never
              scrolls horizontally. */}
          <div className="p-4 lg:p-6 mx-auto" style={{ maxWidth: 960 }}>
            <Outlet />
          </div>
        </main>
      )}
    </div>
  );
}
