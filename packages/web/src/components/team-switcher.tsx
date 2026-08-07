import type { Organization, OrgBrief } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ChevronDown, Loader2, LogOut, Pencil, Plus, UserPlus } from "lucide-react";
import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { leaveMembership } from "../api/members.js";
import { updateOrganization } from "../api/organizations.js";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { Avatar } from "./avatar.js";
import { isAskAgentNavLocked, useAskAgentNavLocked } from "./chat/ask-agent-nav-lock.js";
import { InviteDialog } from "./invite-dialog.js";
import { TeamSetupModal } from "./team-setup-modal.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";

// Floor for how long the "Switching to {name}…" veil stays up, so a fast
// switch (cache clear + reconnect + /me) doesn't flash the veil for a single
// frame. Tunable by feel during QA.
const MIN_SHOW_MS = 300;

// One row grid for every menu action (Invite / own agent / Leave / Switch /
// Create): same gutter, same icon column, same full-bleed hover hit area, so
// the groups can't drift apart again. Per-row color and disabled opacity stay
// on the row's own `style`.
const MENU_ROW_CLASS =
  "flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-body transition-colors hover:bg-[var(--bg-hover)]";

/**
 * Header-left team anchor: the always-present "which team am I in" marker and
 * the entry point for switching teams + team management. Consolidates the
 * team half of the old right-side user menu — the org list, `selectOrganization`,
 * Create / Invite entries, the external-agent setup shortcut, and the
 * `TeamSetupModal` / `InviteDialog` mounts all live here now; the avatar menu
 * is account-only.
 *
 * One state drives the whole switch (`switchingOrg`, from `auth-context`): the
 * picked row spins + the rest of the list disables, the anchor optimistically
 * shows the target team, and a single `TeamSwitchOverlay` veils the content —
 * replacing the old per-component blank-skeleton flash. The data isolation from
 * PR 1221 (`queryClient.clear()` inside `selectOrganization`) is unchanged.
 */
export function TeamSwitcher({
  variant = "full",
  // After a successful switch we land on the workspace root because deep routes
  // (e.g. an agent detail) don't exist under the newly selected org. The DEV
  // preview sets this false to stay mounted (it has no nested router to absorb
  // the navigation).
  redirectHomeOnSwitch = true,
}: {
  variant?: "full" | "compact";
  redirectHomeOnSwitch?: boolean;
}) {
  const {
    organizationId,
    currentMembership,
    role,
    teamDisplayName,
    selectOrganization,
    switchingOrg,
    setSwitchingOrg,
    refreshMe,
  } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // While an Ask agent attempt is pending, surface-leaving actions either
  // navigate or clear org-scoped caches — destroying the attempt's owning
  // surface. The trigger goes inert and every such action re-checks the lock
  // imperatively (a menu opened before the attempt started).
  const askAgentNavLocked = useAskAgentNavLocked();
  const [open, setOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [setupAction, setSetupAction] = useState<"create" | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // Org id whose last switch attempt failed, so we can show a retry hint
  // without conflating it with a fresh attempt.
  const [switchError, setSwitchError] = useState<string | null>(null);
  const renameInputId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialMenuFocusRef = useRef<"first" | "last">("first");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const switchTimerRef = useRef<number | null>(null);

  // Shared `me-organizations` cache: the rename dialog updates this key,
  // so the anchor + switch list refresh without a reload.
  // Best-effort — on failure the anchor still renders the current team from
  // useAuth (see currentOrg fallback below).
  const { data: orgs = [] } = useQuery({
    queryKey: ["me-organizations"],
    queryFn: () => api.get<OrgBrief[]>("/me/organizations"),
    enabled: !!organizationId,
  });

  const fallbackRole: "admin" | "member" = role === "admin" ? "admin" : "member";
  // Current team: prefer the fetched list (full name + role), else fall back to
  // what useAuth already knows so the anchor never waits on /me/organizations.
  const currentOrg: OrgBrief | null = organizationId
    ? (orgs.find((o) => o.id === organizationId) ?? {
        id: organizationId,
        name: teamDisplayName ?? "",
        displayName: teamDisplayName ?? "Current team",
        role: fallbackRole,
      })
    : null;
  const others = organizationId ? orgs.filter((o) => o.id !== organizationId) : [];
  // Anchor reads the optimistic target while switching, so it flips to the
  // destination on click and self-reverts if the switch fails.
  const anchorName = switchingOrg?.displayName ?? currentOrg?.displayName ?? "Current team";
  const anchorSeed = switchingOrg?.id ?? currentOrg?.id ?? "current-team";

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const escHandler = (e: KeyboardEvent) => {
      if (open && e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", escHandler);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", escHandler);
    };
  }, [open]);

  // Drop a stale retry hint when the menu is dismissed.
  useEffect(() => {
    if (!open) setSwitchError(null);
  }, [open]);

  useEffect(() => {
    if (!renameDialogOpen) setRenameDraft(currentOrg?.displayName ?? "");
  }, [currentOrg?.displayName, renameDialogOpen]);

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    if (!items?.length) return;
    const target = initialMenuFocusRef.current === "last" ? items[items.length - 1] : items[0];
    initialMenuFocusRef.current = "first";
    target?.focus();
  }, [open]);

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }
    };
  }, []);

  const renameMutation = useMutation({
    mutationFn: (displayName: string) => {
      if (!organizationId) throw new Error("organization not loaded");
      return updateOrganization(organizationId, { displayName });
    },
    onSuccess: (next: Organization) => {
      queryClient.setQueryData(["organization", organizationId], next);
      queryClient.setQueryData<OrgBrief[]>(["me-organizations"], (prev) =>
        prev?.map((org) => (org.id === next.id ? { ...org, name: next.name, displayName: next.displayName } : org)),
      );
      setRenameDraft(next.displayName);
      setRenameDialogOpen(false);
      void refreshMe();
    },
  });

  const switchAfterLeave = async (org: OrgBrief) => {
    if (isAskAgentNavLocked()) return;
    setSwitchError(null);
    setSwitchingOrg(org);
    const startedAt = Date.now();
    try {
      await selectOrganization(org.id);
      if (redirectHomeOnSwitch) navigate("/", { replace: true });
      const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - startedAt));
      if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
      switchTimerRef.current = window.setTimeout(() => {
        switchTimerRef.current = null;
        setSwitchingOrg(null);
      }, wait);
    } catch {
      setSwitchingOrg(null);
      setSwitchError(org.id);
      setOpen(true);
    }
  };

  const leaveMutation = useMutation({
    mutationFn: async () => {
      if (!currentMembership?.id) throw new Error("current membership not loaded");
      await leaveMembership(currentMembership.id);
    },
    onSuccess: async () => {
      const nextOrg = others[0] ?? null;
      setLeaveConfirmOpen(false);
      setOpen(false);
      await refreshMe();
      if (nextOrg) {
        await switchAfterLeave(nextOrg);
      } else {
        queryClient.clear();
        if (redirectHomeOnSwitch) navigate("/onboarding", { replace: true });
      }
    },
  });

  const handleSwitch = async (org: OrgBrief) => {
    if (isAskAgentNavLocked()) return;
    if (org.id === organizationId) {
      setOpen(false);
      return;
    }
    if (switchingOrg) return; // hard guard: ignore clicks while a switch is in flight
    setSwitchError(null);
    setSwitchingOrg(org); // → veil + optimistic anchor + row spinner + list disabled
    const startedAt = Date.now();
    try {
      // PR 1221: clears every org-scoped React-Query cache, reconnects the
      // admin WebSocket to the new org, and refetches /me. Unchanged.
      await selectOrganization(org.id);
      setOpen(false);
      if (redirectHomeOnSwitch) navigate("/", { replace: true });
      // Hold the veil through the cache-clear → home-mount gap, but no longer
      // than needed, so a fast switch doesn't flash it for one frame.
      const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - startedAt));
      if (switchTimerRef.current !== null) window.clearTimeout(switchTimerRef.current);
      switchTimerRef.current = window.setTimeout(() => {
        switchTimerRef.current = null;
        setSwitchingOrg(null);
      }, wait);
    } catch {
      // Roll the optimistic anchor back and re-enable the list; keep the menu
      // open with an inline retry hint.
      setSwitchingOrg(null);
      setSwitchError(org.id);
    }
  };

  const startRenaming = () => {
    renameMutation.reset();
    setRenameDraft(currentOrg?.displayName ?? "");
    setOpen(false);
    setRenameDialogOpen(true);
  };

  const cancelRenaming = () => {
    renameMutation.reset();
    setRenameDraft(currentOrg?.displayName ?? "");
    setRenameDialogOpen(false);
  };

  const openLeaveConfirm = () => {
    if (isAskAgentNavLocked()) return;
    leaveMutation.reset();
    setOpen(false);
    setLeaveConfirmOpen(true);
  };

  const handleRenameSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (isAskAgentNavLocked()) return;
    const nextName = renameDraft.trim();
    if (!currentOrg || !nextName || renameMutation.isPending) return;
    if (nextName === currentOrg.displayName) {
      setRenameDialogOpen(false);
      return;
    }
    renameMutation.mutate(nextName);
  };

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    e.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Home") {
      items[0]?.focus();
      return;
    }
    if (e.key === "End") {
      items[items.length - 1]?.focus();
      return;
    }
    const direction = e.key === "ArrowDown" ? 1 : -1;
    const nextIndex = activeIndex === -1 ? (direction === 1 ? 0 : items.length - 1) : activeIndex + direction;
    items[(nextIndex + items.length) % items.length]?.focus();
  };

  // Hooks above run unconditionally; bail out only after them. No selected org
  // (e.g. mid-onboarding) → no anchor; Create / Join is carried by onboarding.
  if (!organizationId || !currentOrg) return null;
  const isCompact = variant === "compact";
  const canRenameTeam = role === "admin";
  const trimmedRenameDraft = renameDraft.trim();
  const renameDisabled =
    !trimmedRenameDraft ||
    trimmedRenameDraft === currentOrg.displayName ||
    renameMutation.isPending ||
    askAgentNavLocked;

  return (
    <>
      <div ref={ref} className="relative" data-testid="team-switcher">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Switch team, current: ${currentOrg.displayName}`}
          disabled={askAgentNavLocked}
          onClick={() => {
            initialMenuFocusRef.current = "first";
            setOpen((v) => !v);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            initialMenuFocusRef.current = e.key === "ArrowUp" ? "last" : "first";
            setOpen(true);
          }}
          className={cn(
            "inline-flex items-center border transition-colors",
            open
              ? "border-[var(--border-strong)] bg-[var(--bg-hover)]"
              : isCompact
                ? "border-[var(--border)] bg-[var(--bg)] hover:bg-[var(--bg-hover)]"
                : "border-transparent bg-[var(--bg)] hover:border-[var(--border)] hover:bg-[var(--bg-hover)]",
          )}
          style={{
            gap: "var(--sp-1_75)",
            padding: isCompact ? "var(--sp-1) var(--sp-1_25)" : "var(--sp-1) var(--sp-2) var(--sp-1) var(--sp-1_25)",
            borderRadius: "var(--radius-input)",
            maxWidth: isCompact ? undefined : 185,
            cursor: askAgentNavLocked ? "default" : "pointer",
            opacity: askAgentNavLocked ? 0.5 : undefined,
          }}
        >
          <Avatar seed={anchorSeed} name={anchorName} size={18} />
          {!isCompact && (
            <span className="min-w-0 flex-1 truncate text-body" style={{ color: "var(--fg)" }}>
              {anchorName}
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 flex-none" style={{ color: "var(--fg-3)" }} />
        </button>

        {open && (
          <div
            ref={menuRef}
            role="menu"
            aria-label="Team menu"
            onKeyDown={handleMenuKeyDown}
            // z-[46]: above the switch veil (45) so the in-menu spinner stays
            // visible during a switch, and above content overlays (conv-list /
            // right-rail z-30, doc drawer z-40); below dialogs (z-50).
            className="absolute left-0 z-[46] mt-2 overflow-hidden rounded-[var(--radius-panel)] border bg-popover shadow-[var(--shadow-md)]"
            style={{ width: "var(--sp-70)", borderColor: "var(--border)" }}
          >
            {/* ① Current team identity and actions — always shown. */}
            <div role="presentation" className="border-b pb-1" style={{ borderColor: "var(--border)" }}>
              <div
                aria-hidden="true"
                className="text-eyebrow"
                style={{ color: "var(--fg-3)", padding: "var(--sp-1_25) var(--sp-3_5) var(--sp-0_75)" }}
              >
                Current team
              </div>
              {/* Identity row: taller than an action row (avatar + two text
                  lines), but on the same gutter as every other row. */}
              <div role="presentation" className="flex items-start gap-2.5 px-3.5 py-1.5">
                <Avatar seed={currentOrg.id} name={currentOrg.displayName} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-subtitle" title={currentOrg.displayName} style={{ color: "var(--fg)" }}>
                    {currentOrg.displayName}
                  </div>
                  <div className="truncate text-label" style={{ color: "var(--fg-3)" }}>
                    {currentOrg.role === "admin" ? "Admin" : "Member"}
                  </div>
                </div>
                {canRenameTeam && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    aria-label="Rename team"
                    title="Rename team"
                    onClick={startRenaming}
                    disabled={askAgentNavLocked}
                    className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[var(--radius-input)] border transition-colors hover:bg-[var(--bg-hover)]"
                    style={{
                      borderColor: "var(--border)",
                      color: "var(--fg-3)",
                      opacity: askAgentNavLocked ? 0.5 : undefined,
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {/* Invite is a current-team membership action, not a creation flow. */}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={askAgentNavLocked}
                onClick={() => {
                  if (isAskAgentNavLocked()) return;
                  setOpen(false);
                  setInviteOpen(true);
                }}
                className={MENU_ROW_CLASS}
                style={{ color: "var(--fg)", opacity: askAgentNavLocked ? 0.5 : undefined }}
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>Invite teammates</span>
              </button>
              {/* TeamSwitcher preserves the active-Team context; Settings owns
                  the actual external-agent Context Tree configuration. */}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={askAgentNavLocked}
                onClick={() => {
                  if (isAskAgentNavLocked()) return;
                  setOpen(false);
                  navigate("/settings/context#coding-agent-access");
                }}
                className={MENU_ROW_CLASS}
                style={{ color: "var(--fg)", opacity: askAgentNavLocked ? 0.5 : undefined }}
              >
                <Bot className="h-3.5 w-3.5" />
                <span>Use your own agent</span>
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={openLeaveConfirm}
                disabled={askAgentNavLocked}
                className={MENU_ROW_CLASS}
                style={{ color: "var(--state-error)", opacity: askAgentNavLocked ? 0.5 : undefined }}
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Leave team</span>
              </button>
            </div>

            {/* ② Switch list — other teams only; hidden for single-team users. */}
            {others.length > 0 && (
              <div role="presentation" className="border-b" style={{ borderColor: "var(--border)" }}>
                <div
                  aria-hidden="true"
                  className="text-eyebrow"
                  style={{ color: "var(--fg-3)", padding: "var(--sp-1_25) var(--sp-3_5) var(--sp-0_75)" }}
                >
                  Switch team
                </div>
                <div
                  style={{
                    maxHeight: "var(--sp-45)",
                    overflowY: "auto",
                    pointerEvents: switchingOrg ? "none" : undefined,
                  }}
                >
                  {others.map((o) => {
                    const isBusy = switchingOrg?.id === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        disabled={!!switchingOrg || askAgentNavLocked}
                        aria-busy={isBusy}
                        onClick={() => void handleSwitch(o)}
                        className={MENU_ROW_CLASS}
                        style={{
                          color: "var(--fg)",
                          opacity: (switchingOrg || askAgentNavLocked) && !isBusy ? 0.45 : undefined,
                        }}
                      >
                        <span className="inline-flex flex-none justify-center" style={{ width: 18 }}>
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Avatar seed={o.id} name={o.displayName} size={18} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate" title={o.displayName}>
                          {o.displayName}
                        </span>
                        <RoleBadge role={o.role} dim />
                      </button>
                    );
                  })}
                </div>
                {switchError && (
                  <div
                    role="alert"
                    className="text-label"
                    style={{ padding: "var(--sp-1) var(--sp-3_5) var(--sp-1_5)", color: "var(--color-error)" }}
                  >
                    Couldn't switch — try again
                  </div>
                )}
              </div>
            )}

            {/* ③ Add team — always shown. Create completes via `TeamSetupModal`'s
                `selectOrganization` + `/onboarding` navigation, so it is guarded
                exactly like the switch rows: inert while a pending Ask agent
                attempt owns the surface, plus an imperative re-check at the
                action boundary. Invite recipients join through the shared
                `/invite/:token` URL instead of pasting that URL back into Web. */}
            <div role="presentation" className="py-1">
              <div
                aria-hidden="true"
                className="text-eyebrow"
                style={{ color: "var(--fg-3)", padding: "var(--sp-1_25) var(--sp-3_5) var(--sp-0_75)" }}
              >
                Add team
              </div>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={askAgentNavLocked}
                onClick={() => {
                  if (isAskAgentNavLocked()) return;
                  setOpen(false);
                  setSetupAction("create");
                }}
                className={MENU_ROW_CLASS}
                style={{ color: "var(--fg)", opacity: askAgentNavLocked ? 0.5 : undefined }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Create team</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <TeamSetupModal action={setupAction} onClose={() => setSetupAction(null)} />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <Dialog
        open={renameDialogOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setRenameDialogOpen(true);
            return;
          }
          if (!renameMutation.isPending) cancelRenaming();
        }}
      >
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            triggerRef.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (renameMutation.isPending) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (renameMutation.isPending) e.preventDefault();
          }}
        >
          <form className="grid gap-4" onSubmit={handleRenameSubmit}>
            <DialogHeader>
              <DialogTitle>Rename team</DialogTitle>
              <DialogDescription style={{ color: "var(--fg-2)" }}>
                Update the display name for this team.
              </DialogDescription>
            </DialogHeader>
            <label htmlFor={renameInputId} className="grid gap-1.5 text-label" style={{ color: "var(--fg-2)" }}>
              Team name
              <Input
                id={renameInputId}
                ref={renameInputRef}
                aria-label="Team name"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                disabled={renameMutation.isPending}
                maxLength={200}
              />
            </label>
            {renameMutation.error instanceof Error && (
              <p role="alert" className="text-body" style={{ color: "var(--state-error)" }}>
                {renameMutation.error.message}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancelRenaming} disabled={renameMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={renameDisabled}>
                {renameMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {renameMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={leaveConfirmOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !leaveMutation.isPending) setLeaveConfirmOpen(false);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Leave {currentOrg.displayName}?</DialogTitle>
            <DialogDescription style={{ color: "var(--fg-2)" }}>
              This removes only your membership from this team. The team, its settings, and its history stay intact.
            </DialogDescription>
          </DialogHeader>
          <div
            className="flex flex-col gap-2 rounded-[var(--radius-panel)] border p-3 text-body"
            style={{ borderColor: "var(--border)" }}
          >
            <span>You will need an invite to join this team again.</span>
            <span>
              Any agents you manage here will be transferred to another admin and unpinned from your computers. If you
              are the only admin and still manage agents, leaving is blocked until another admin can take them over.
            </span>
          </div>
          {leaveMutation.error instanceof Error && (
            <p role="alert" className="text-body" style={{ color: "var(--state-error)" }}>
              {leaveMutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLeaveConfirmOpen(false)}
              disabled={leaveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (isAskAgentNavLocked()) return;
                leaveMutation.mutate();
              }}
              disabled={leaveMutation.isPending}
            >
              {leaveMutation.isPending ? "Leaving…" : "Leave team"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RoleBadge({ role, dim }: { role: string | null | undefined; dim?: boolean }) {
  if (role !== "admin" && role !== "member") return null;
  return (
    <span
      className="mono uppercase text-caption"
      style={{
        padding: "var(--hairline) var(--sp-1_75)",
        borderRadius: "var(--radius-chip)",
        color: "var(--fg-3)",
        border: "var(--hairline) solid var(--border)",
        background: "var(--bg-sunken)",
        opacity: dim ? 0.8 : undefined,
      }}
    >
      {role}
    </span>
  );
}
