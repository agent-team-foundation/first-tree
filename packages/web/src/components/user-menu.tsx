import type { OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { Check, LogOut, Plus, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Avatar } from "./avatar.js";
import { TeamSetupModal } from "./team-setup-modal.js";

/**
 * Right-side user menu. Avatar trigger; dropdown nests team switching,
 * admin team management, Create / Join entry points, and sign-out.
 *
 * Replaces the previous brand-side OrganizationSwitcher and the
 * standalone right-side logout button. Single org users see the same
 * dropdown as multi-org users — the Create / Join entries are always
 * present so they can self-serve into a multi-org state.
 */
export function UserMenu() {
  const { organizationId, role, user, selectOrganization, logout } = useAuth();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [open, setOpen] = useState(false);
  const [setupAction, setSetupAction] = useState<"create" | "join" | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort; the static avatar still works
      }
    })();
  }, []);

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
  const currentOrg = orgs.find((o) => o.id === organizationId) ?? null;
  const currentRole = currentOrg?.role ?? (role === "admin" || role === "member" ? role : null);

  const switchOrg = async (id: string) => {
    if (id === organizationId) {
      setOpen(false);
      return;
    }
    try {
      // selectOrganization persists `localStorage.selectedOrganizationId`
      // and refreshes /me. The server returns 204 — no token swap, the WS
      // session keeps its bound agents (decouple-client-from-identity §4.6).
      await selectOrganization(id);
      setOpen(false);
      navigate("/", { replace: true });
    } catch {
      // keep dropdown open so the user can retry
    }
  };

  const openCreate = () => {
    setOpen(false);
    setSetupAction("create");
  };
  const openJoin = () => {
    setOpen(false);
    setSetupAction("join");
  };

  return (
    <>
      <div ref={ref} className="relative" data-testid="user-menu">
        <button
          type="button"
          aria-label={`User menu, ${displayName}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-ring transition-shadow"
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
            className="absolute right-0 z-30 mt-2 rounded-md border bg-popover shadow-md"
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

            {/* Teams section — proposal §"OrganizationSwitcher":
                single-org users see a static label (the user still
                needs to know which team they're in), multi-org users
                get clickable rows with a checkmark on the active one. */}
            {orgs.length > 0 && (
              <div className="border-b py-1" style={{ borderColor: "var(--border)" }}>
                <div className="px-4 py-1 text-eyebrow text-muted-foreground">Current team</div>
                {orgs.length === 1 ? (
                  <div
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body"
                    style={{ color: "var(--fg)" }}
                  >
                    <span style={{ width: 14, display: "inline-flex" }}>
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{orgs[0]?.displayName}</span>
                    <RoleBadge role={orgs[0]?.role ?? currentRole} />
                  </div>
                ) : (
                  <div>
                    {orgs.map((o) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={o.id}
                        onClick={() => void switchOrg(o.id)}
                        className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body hover:bg-accent transition-colors"
                        style={{ color: "var(--fg)" }}
                      >
                        <span style={{ width: 14, display: "inline-flex" }}>
                          {o.id === organizationId ? <Check className="h-3.5 w-3.5" /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{o.displayName}</span>
                        <RoleBadge role={o.role} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Org actions */}
            <div className="border-b py-1" style={{ borderColor: "var(--border)" }}>
              <button
                type="button"
                role="menuitem"
                onClick={openCreate}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body hover:bg-accent transition-colors"
                style={{ color: "var(--fg)" }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Create new team</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={openJoin}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-body hover:bg-accent transition-colors"
                style={{ color: "var(--fg)" }}
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>Join with invite link</span>
              </button>
            </div>

            {/* User actions */}
            <div className="py-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  logout();
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

      <TeamSetupModal action={setupAction} onClose={() => setSetupAction(null)} />
    </>
  );
}

function RoleBadge({ role }: { role: string | null | undefined }) {
  if (role !== "admin" && role !== "member") return null;
  return (
    <span
      className="mono uppercase text-caption"
      style={{
        padding: "var(--hairline) var(--sp-1_75)",
        borderRadius: "var(--radius-chip)",
        color: role === "admin" ? "var(--accent-dim)" : "var(--fg-3)",
        border: "var(--hairline) solid var(--border)",
        background: role === "admin" ? "var(--accent-bg)" : "var(--bg-sunken)",
      }}
    >
      {role}
    </span>
  );
}
