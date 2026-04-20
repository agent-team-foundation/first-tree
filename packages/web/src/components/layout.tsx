import { Leaf, LogOut, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { CommandPalette } from "../pages/workspace/palette/command-palette.js";
import { NotificationBell } from "./notification-bell.js";
import { ThemeToggle } from "./ui/theme-toggle.js";

const navTabs = [
  { to: "/", label: "Workspace", end: true, kbd: "⌘1" },
  { to: "/agents", label: "Agents", end: false, kbd: "⌘2" },
  { to: "/clients", label: "Computers", end: false, kbd: "⌘3" },
];

const adminTab = { to: "/admin", label: "Admin", end: false, kbd: "⌘4" };

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
          height: 40,
          gridTemplateColumns: "auto 1fr auto",
          padding: "0 12px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-raised)",
        }}
      >
        {/* Brand */}
        <div className="flex items-center" style={{ gap: 10 }}>
          <Leaf className="h-4 w-4" style={{ color: "var(--accent)" }} />
          <span
            style={{
              fontWeight: 600,
              fontSize: 13,
              letterSpacing: -0.1,
              color: "var(--fg)",
            }}
          >
            First Tree <span style={{ color: "var(--fg-3)", fontWeight: 400 }}>Hub</span>
          </span>
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
                  className="inline-flex items-center"
                  style={{
                    padding: "5px 12px",
                    fontSize: 12,
                    fontWeight: 500,
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
            className="inline-flex items-center transition-colors"
            style={{
              gap: 8,
              padding: "4px 8px",
              fontSize: 11,
              color: "var(--fg-3)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--bg-sunken)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--fg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--fg-3)";
            }}
          >
            <Search className="h-3.5 w-3.5" />
            <span>Jump to…</span>
            <span className="kbd">⌘K</span>
          </button>
          <span
            style={{
              width: 1,
              height: 18,
              background: "var(--border)",
              margin: "0 4px",
            }}
          />
          <NotificationBell />
          <ThemeToggle />
          <span
            style={{
              width: 1,
              height: 18,
              background: "var(--border)",
              margin: "0 4px",
            }}
          />
          <button
            type="button"
            onClick={logout}
            className="inline-flex items-center transition-colors hover:text-[var(--fg)]"
            style={{
              padding: "4px 8px",
              color: "var(--fg-3)",
              borderRadius: 4,
              gap: 6,
              fontSize: 11,
            }}
            aria-label="Log out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />

      {/* Main content */}
      {isWorkspace ? (
        <Outlet />
      ) : (
        <main className="flex-1 overflow-auto">
          <div className="p-6 max-w-5xl mx-auto">
            <Outlet />
          </div>
        </main>
      )}
    </div>
  );
}
