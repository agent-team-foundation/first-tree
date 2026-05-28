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

  // Top-bar progressive collapse: at `md` (768–1279) drop the right controls
  // (cmdk / theme / user); at `narrow` (<768) also drop the brand cluster.
  // The four nav tabs always survive — that's the minimum viable header.
  const viewport = useWorkspaceViewport();
  const dropControls = viewport !== "xl";
  const dropBrand = viewport === "narrow";
  const headerColumns = dropBrand ? "1fr" : dropControls ? "1fr auto" : "1fr auto 1fr";

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
            pointerEvents: "none",
            // On `narrow` the header has a single column and tabs become
            // its sole content — anchor to the start so they don't push
            // off the right edge.
            justifySelf: dropBrand ? "start" : "center",
          }}
        >
          {navTabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              style={{ pointerEvents: "auto" }}
              className={({ isActive }) =>
                cn("inline-flex items-center transition-colors", isActive ? "" : "hover:text-[var(--fg)]")
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

        {/* Right controls — collapse at `md` and below. */}
        {dropControls ? null : (
          <div className="flex items-center" style={{ gap: 6, justifySelf: "end" }}>
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
            <ThemeToggle />
            <span
              style={{
                width: 1,
                height: 18,
                background: "var(--border)",
                margin: "0 var(--sp-1)",
              }}
            />
            <UserMenu />
          </div>
        )}
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
