import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth-context.js";
import { showLogoutIncompleteToast } from "../auth/logout-recovery.js";
import { captureBrowserStorageScope } from "../lib/browser-storage-scope.js";
import { Avatar } from "./avatar.js";
import { useOptionalToast } from "./ui/toast.js";

// Marketing site — where an explicit sign-out lands the browser, so the user
// leaves the app on the parent brand surface rather than an app route (which
// would just bounce back through the login page). Mirrors `PARENT_URL` in
// layout.tsx / footer.tsx.
const PARENT_URL = "https://first-tree.ai";

/**
 * Right-side account menu. Avatar trigger; dropdown shows the signed-in user
 * and Sign out.
 *
 * Team switching and team management (the org list, Create / Join / Invite)
 * moved to the header-left `TeamSwitcher` — team and account are now separate
 * surfaces (team on the left, account on the right).
 */
export function UserMenu() {
  const { user, logout } = useAuth();
  const { addToast } = useOptionalToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (open && e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", escHandler);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", escHandler);
    };
  }, [open]);

  const displayName = user?.displayName ?? "User";
  const username = user?.username ?? "";
  const avatarSrc = user?.avatarUrl ?? null;

  return (
    <div ref={ref} className="relative" data-testid="user-menu">
      <button
        type="button"
        aria-label={`User menu, ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center justify-center rounded-full focus:outline-none focus:ring-1 focus:ring-ring transition-shadow"
        style={{
          background: "transparent",
          border: open ? "var(--hairline) solid var(--border)" : "var(--hairline) solid transparent",
          padding: 1,
          cursor: "pointer",
        }}
      >
        <Avatar src={avatarSrc} name={displayName} size={28} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 rounded-[var(--radius-panel)] border bg-popover shadow-md"
          style={{ width: 280 }}
        >
          {/* User header */}
          <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
            <Avatar src={avatarSrc} name={displayName} size={32} />
            <div className="min-w-0">
              <div className="text-subtitle font-medium truncate" style={{ color: "var(--fg)" }}>
                {displayName}
              </div>
              {username && username !== displayName && (
                <div className="text-label text-muted-foreground truncate">@{username}</div>
              )}
            </div>
          </div>

          {/* User actions */}
          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void (async () => {
                  let completed = false;
                  const departingScope = captureBrowserStorageScope();
                  try {
                    completed = (await Promise.resolve(logout({ scope: departingScope }))) === true;
                  } catch {
                    completed = false;
                  }
                  if (!completed) {
                    showLogoutIncompleteToast(addToast, () =>
                      logout({ protectReplacementTokens: true, scope: departingScope }),
                    );
                    return;
                  }
                  // Leave the app on the marketing site rather than an app
                  // route — `logout()` clears local auth state, so staying in
                  // the SPA would just redirect to the login page.
                  window.location.href = PARENT_URL;
                })();
              }}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body hover:bg-accent transition-colors"
              style={{ color: "var(--fg)" }}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
