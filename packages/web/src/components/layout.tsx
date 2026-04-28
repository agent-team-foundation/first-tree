import { LogOut, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { CommandPalette } from "../pages/workspace/palette/command-palette.js";
import { FirstTreeLogo } from "./first-tree-logo.js";
import { NotificationBell } from "./notification-bell.js";
import { OrganizationSwitcher } from "./organization-switcher.js";
import { ThemeToggle } from "./ui/theme-toggle.js";

const navTabs = [
  { to: "/", label: "Workspace", end: true, kbd: "⌘1" },
  { to: "/agents", label: "Agents", end: false, kbd: "⌘2" },
  { to: "/clients", label: "Computers", end: false, kbd: "⌘3" },
  { to: "/settings", label: "Settings", end: false, kbd: "⌘4" },
];

const adminTab = { to: "/admin", label: "Admin", end: false, kbd: "⌘5" };

export function Layout() {
  const { role, logout } = useAuth();
  const isAdmin = role === "admin";
  const [paletteOpen, setPaletteOpen] = useState(false);

  const tabs = isAdmin ? [...navTabs, adminTab] : navTabs;

  const location = useLocation();
  const isWorkspace = location.pathname === "/" || location.search.includes("a=");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: "100vh", background: "var(--bg)" }}>
      {/* Top bar */}
      <header
        className="relative shrink-0 grid items-center"
        style={{
          height: 48,
          gridTemplateColumns: "auto 1fr auto",
          padding: "0 var(--sp-3)",
          borderBottom: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
        }}
      >
        {/* Brand */}
        <div className="flex items-center" style={{ gap: 10 }}>
          <FirstTreeLogo width={16} height={18} style={{ color: "var(--fg)" }} />
          {/* Brand uses the `text-title` token (16 / 600 / -0.2 letter-spacing). */}
          <span className="text-title" style={{ color: "var(--fg)" }}>
            First Tree{" "}
            <span className="font-normal" style={{ color: "var(--fg-3)" }}>
              Hub
            </span>
          </span>
          <OrganizationSwitcher />
        </div>

        {/* Tabs */}
        <nav className="flex justify-center" style={{ gap: 2, pointerEvents: "none" }}>
          {tabs.map((tab) => (
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
                  {isActive && <span className="kbd">{tab.kbd}</span>}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Right controls */}
        <div className="flex items-center" style={{ gap: 6 }}>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
            className="inline-flex items-center transition-colors text-body"
            style={{
              gap: 8,
              padding: "var(--sp-1) var(--sp-2)",
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
            <span>Jump to…</span>
            <span className="kbd">⌘K</span>
          </button>
          <span
            style={{
              width: 1,
              height: 18,
              background: "var(--border)",
              margin: "0 var(--sp-1)",
            }}
          />
          <NotificationBell />
          <ThemeToggle />
          <span
            style={{
              width: 1,
              height: 18,
              background: "var(--border)",
              margin: "0 var(--sp-1)",
            }}
          />
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center transition-colors hover:text-[var(--fg)] text-body"
            style={{
              padding: "var(--sp-1) var(--sp-2)",
              color: "var(--fg-3)",
              borderRadius: "var(--radius-input)",
              gap: 6,
            }}
            aria-label="Log out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      {/* Main content */}
      {isWorkspace ? (
        <Outlet />
      ) : (
        <main className="flex-1 overflow-auto">
          <div className="p-6 mx-auto" style={{ maxWidth: 1280 }}>
            <Outlet />
          </div>
        </main>
      )}
    </div>
  );
}
