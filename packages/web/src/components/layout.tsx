import { Bot, LogOut } from "lucide-react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { NotificationBell } from "./notification-bell.js";

const navTabs = [
  { to: "/", label: "Workspace", end: true },
  { to: "/agents", label: "Agents", end: false },
];

const adminTab = { to: "/admin", label: "Admin", end: false };

export function Layout() {
  const { role, logout } = useAuth();
  const isAdmin = role === "admin";

  const tabs = isAdmin ? [...navTabs, adminTab] : navTabs;

  // Workspace route uses full viewport (no padding/max-width)
  const location = useLocation();
  const isWorkspace = location.pathname === "/" || location.search.includes("a=");

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top bar */}
      <header className="relative h-12 shrink-0 border-b border-border bg-card flex items-center px-4">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm tracking-tight">First Tree</span>
        </div>

        <nav className="absolute inset-x-0 flex items-center justify-center gap-1 pointer-events-none">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                cn(
                  "pointer-events-auto px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground",
                )
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <button
            type="button"
            onClick={logout}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

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
