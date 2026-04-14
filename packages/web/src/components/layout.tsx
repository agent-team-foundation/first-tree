import type { LucideIcon } from "lucide-react";
import { Activity, Bot, Cable, LayoutDashboard, LogOut, MessageSquare, Settings, Users } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";

type NavItem = {
  to: string;
  icon: LucideIcon;
  label: string;
  adminOnly?: boolean;
};

const navItems: NavItem[] = [
  { to: "/", icon: LayoutDashboard, label: "Overview" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/activity", icon: Activity, label: "Activity" },
  { to: "/bindings", icon: Cable, label: "Bindings", adminOnly: true },
  { to: "/chats", icon: MessageSquare, label: "Chats" },
  { to: "/members", icon: Users, label: "Members", adminOnly: true },
  { to: "/settings", icon: Settings, label: "Settings", adminOnly: true },
];

export function Layout() {
  const { role, logout } = useAuth();
  const isAdmin = role === "admin";

  const visibleItems = navItems.filter((item) => !item.adminOnly || isAdmin);

  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-semibold tracking-tight">First Tree</h1>
          <p className="text-xs text-muted-foreground">Workspace</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-2 border-t border-border">
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6 max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
