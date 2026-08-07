import { LogOut, Settings, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { useMobileExperienceState } from "../hooks/use-mobile-experience.js";
import { Avatar } from "./avatar.js";
import { isAskAgentNavLocked, useAskAgentNavLocked } from "./chat/ask-agent-nav-lock.js";
import { OpenOnMobileDialog } from "./mobile-install-promotion.js";

// Marketing site — where an explicit sign-out lands the browser, so the user
// leaves the app on the parent brand surface rather than an app route (which
// would just bounce back through the login page). Mirrors `PARENT_URL` in
// layout.tsx / footer.tsx.
const PARENT_URL = "https://first-tree.ai";

/**
 * Right-side account menu. Avatar trigger; dropdown shows the signed-in user
 * and account actions.
 *
 * Team switching and team management (the org list, Create / Invite, and the
 * own-agent setup shortcut) moved to the header-left `TeamSwitcher` — team and
 * account are now separate surfaces (team on the left, account on the right).
 */
export function UserMenu() {
  const { user, logout } = useAuth();
  const mobileExperience = useMobileExperienceState();
  const navigate = useNavigate();
  // While an Ask agent attempt is pending, Account settings navigates away
  // and Sign out leaves the app entirely — both destroy the attempt's owning
  // surface. The trigger goes inert and the actions re-check the lock
  // imperatively (a menu opened before the attempt started).
  const askAgentNavLocked = useAskAgentNavLocked();
  const [open, setOpen] = useState(false);
  const [mobileDialogOpen, setMobileDialogOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
        ref={triggerRef}
        type="button"
        aria-label={`User menu, ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={askAgentNavLocked}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center justify-center rounded-full focus:outline-none focus:ring-1 focus:ring-ring transition-shadow"
        style={{
          background: "transparent",
          border: open ? "var(--hairline) solid var(--border)" : "var(--hairline) solid transparent",
          padding: 1,
          cursor: askAgentNavLocked ? "default" : "pointer",
          opacity: askAgentNavLocked ? 0.5 : undefined,
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
              disabled={askAgentNavLocked}
              onClick={() => {
                setOpen(false);
                if (isAskAgentNavLocked()) return;
                navigate("/settings/account");
              }}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body hover:bg-accent transition-colors"
              style={{ color: "var(--fg)", opacity: askAgentNavLocked ? 0.5 : undefined }}
            >
              <Settings className="h-3.5 w-3.5" />
              <span>Account settings</span>
            </button>
            {mobileExperience.settled && mobileExperience.enabled ? (
              <button
                type="button"
                role="menuitem"
                aria-haspopup="dialog"
                aria-expanded={mobileDialogOpen}
                onClick={() => {
                  setOpen(false);
                  setMobileDialogOpen(true);
                }}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body hover:bg-accent transition-colors"
                style={{ color: "var(--fg)" }}
              >
                <Smartphone className="h-3.5 w-3.5" />
                <span>Open on mobile</span>
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              disabled={askAgentNavLocked}
              onClick={() => {
                setOpen(false);
                if (isAskAgentNavLocked()) return;
                logout();
                // Leave the app on the marketing site rather than an app
                // route — `logout()` clears local auth state, so staying in
                // the SPA would just redirect to the login page.
                window.location.href = PARENT_URL;
              }}
              className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body hover:bg-accent transition-colors"
              style={{ color: "var(--fg)", opacity: askAgentNavLocked ? 0.5 : undefined }}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>Sign out</span>
            </button>
          </div>
        </div>
      )}
      <OpenOnMobileDialog
        open={mobileDialogOpen}
        onOpenChange={(nextOpen) => {
          setMobileDialogOpen(nextOpen);
          if (!nextOpen) triggerRef.current?.focus();
        }}
        source="user_menu"
        restoreFocusRef={triggerRef}
      />
    </div>
  );
}
