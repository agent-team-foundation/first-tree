import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useWorkspaceViewport } from "../hooks/use-viewport.js";
import { cn } from "../lib/utils.js";
import { CommandPalette } from "../pages/workspace/palette/command-palette.js";
import { DisconnectChip } from "./disconnect-chip.js";
import { FirstTreeLogo } from "./first-tree-logo.js";
import { ThemeToggle } from "./ui/theme-toggle.js";
import { UserMenu } from "./user-menu.js";

const navTabs = [
  { to: "/", label: "Workspace", end: true },
  { to: "/context", label: "Context", end: false },
  { to: "/team", label: "Team", end: false },
  { to: "/settings", label: "Settings", end: false },
];

export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘K / Ctrl+K to open the Jump-to palette from anywhere. Listens at
  // window-level so the shortcut survives inside textareas / editable
  // surfaces; that mirrors how Linear / GitHub / Slack treat their global
  // command palette and matches the existing "Jump to…" affordance, which
  // is the only top-bar control reachable without a click.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const location = useLocation();
  const isWorkspace = location.pathname === "/";
  // Settings owns its own two-column (sidebar + main) layout and centres a
  // ~1160 wrapper instead of the default 960 canvas — let it manage its
  // own width.
  const isSettings = location.pathname.startsWith("/settings");

  // Top-bar progressive collapse, tuned so the user menu (sign-out, org-switch)
  // is reachable at EVERY width — dropping it below `xl` previously stranded
  // every phone / tablet / sub-1280 desktop window with no way to log out.
  //   - `xl`     : brand | tabs | [Jump to…] [theme] [avatar]
  //   - `md`     : brand | tabs | [theme] [avatar]   (Jump to… too wide)
  //   - `narrow` : tabs | [avatar]                   (also drops brand)
  // On `narrow` the theme toggle drops too: four full tabs + theme + avatar
  // overflow a phone-width row and would clip the avatar off the right edge.
  // Phones
  // fall back to the OS `prefers-color-scheme` (honoured at boot in index.html);
  // the toggle returns at `md`. The avatar is the one control that never drops.
  const viewport = useWorkspaceViewport();
  const showJumpButton = viewport === "xl";
  const dropBrand = viewport === "narrow";
  const showThemeToggle = viewport !== "narrow";
  // Brand present → brand | tabs(center) | controls(end). Brand collapsed
  // (narrow) → tabs(start) | controls(end). The narrow tabs track is
  // `minmax(0, 1fr)` (not the default `minmax(auto, 1fr)`) so it can shrink
  // below the tabs' intrinsic width and let them scroll, instead of pushing
  // the avatar past the right edge.
  const headerColumns = dropBrand ? "minmax(0, 1fr) auto" : "1fr auto 1fr";

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
      {/* Top bar */}
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
        {/* Brand cluster: logo + name welded together, then the optional chip. */}
        {dropBrand ? null : (
          <div className="flex items-center" style={{ gap: "var(--sp-3_5)", justifySelf: "start", minWidth: 0 }}>
            <span className="flex items-center" style={{ gap: 10, flexShrink: 0 }}>
              <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)" }} />
              {/* Brand uses the `text-title` token (16 / 600 / -0.2 letter-spacing). */}
              <span className="text-title" style={{ color: "var(--fg)" }}>
                First Tree
              </span>
            </span>
            <DisconnectChip />
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
            ...(dropBrand ? { minWidth: 0, overflowX: "auto" } : null),
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
            theme toggle drops on `narrow` and the wide "Jump to…" button is
            xl-only (see the collapse comment above). */}
        <div className="flex items-center shrink-0" style={{ gap: 6, justifySelf: "end" }}>
          {showJumpButton ? (
            <>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label="Open command palette"
                className="inline-flex items-center transition-colors text-body"
                style={{
                  gap: 8,
                  padding: "var(--sp-1) var(--sp-3)",
                  minWidth: 200,
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
                <Search className="h-4 w-4" />
                <span className="flex-1 text-left">Jump to…</span>
                <span
                  aria-hidden
                  className="text-caption font-mono"
                  style={{
                    padding: "var(--sp-0_5) var(--sp-1_5)",
                    border: "var(--hairline) solid var(--border)",
                    borderRadius: "var(--sp-1)",
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

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

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
