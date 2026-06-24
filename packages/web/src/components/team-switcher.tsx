import type { Organization, OrgBrief } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Link2, Loader2, Pencil, Plus, UserPlus, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { updateOrganization } from "../api/organizations.js";
import { useAuth } from "../auth/auth-context.js";
import { cn } from "../lib/utils.js";
import { Avatar } from "./avatar.js";
import { InviteDialog } from "./invite-dialog.js";
import { TeamSetupModal } from "./team-setup-modal.js";

// Floor for how long the "Switching to {name}…" veil stays up, so a fast
// switch (cache clear + reconnect + /me) doesn't flash the veil for a single
// frame. Tunable by feel during QA.
const MIN_SHOW_MS = 300;

/**
 * Header-left team anchor: the always-present "which team am I in" marker and
 * the entry point for switching teams + team management. Consolidates the
 * team half of the old right-side user menu — the org list, `selectOrganization`,
 * Create / Join / Invite entries, and the `TeamSetupModal` / `InviteDialog`
 * mounts all live here now; the avatar menu is account-only.
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
  const { organizationId, role, teamDisplayName, selectOrganization, switchingOrg, setSwitchingOrg, refreshMe } =
    useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [setupAction, setSetupAction] = useState<"create" | "join" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaved, setRenameSaved] = useState(false);
  // Org id whose last switch attempt failed, so we can show a retry hint
  // without conflating it with a fresh attempt.
  const [switchError, setSwitchError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Shared `me-organizations` cache: the inline rename path updates this key,
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
      if (open && e.key === "Escape") setOpen(false);
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
    if (!renaming) setRenameDraft(currentOrg?.displayName ?? "");
  }, [currentOrg?.displayName, renaming]);

  useEffect(() => {
    if (!open) {
      setRenaming(false);
      setRenameSaved(false);
    }
  }, [open]);

  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

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
      setRenaming(false);
      setRenameSaved(true);
      window.setTimeout(() => setRenameSaved(false), 2000);
      void refreshMe();
    },
  });

  const handleSwitch = async (org: OrgBrief) => {
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
      window.setTimeout(() => setSwitchingOrg(null), wait);
    } catch {
      // Roll the optimistic anchor back and re-enable the list; keep the menu
      // open with an inline retry hint.
      setSwitchingOrg(null);
      setSwitchError(org.id);
    }
  };

  const startRenaming = () => {
    setRenameSaved(false);
    renameMutation.reset();
    setRenameDraft(currentOrg?.displayName ?? "");
    setRenaming(true);
  };

  const cancelRenaming = () => {
    renameMutation.reset();
    setRenameDraft(currentOrg?.displayName ?? "");
    setRenaming(false);
  };

  const handleRenameSubmit = (e: FormEvent) => {
    e.preventDefault();
    const nextName = renameDraft.trim();
    if (!currentOrg || !nextName || renameMutation.isPending) return;
    if (nextName === currentOrg.displayName) {
      setRenaming(false);
      return;
    }
    renameMutation.mutate(nextName);
  };

  // Hooks above run unconditionally; bail out only after them. No selected org
  // (e.g. mid-onboarding) → no anchor; Create / Join is carried by onboarding.
  if (!organizationId || !currentOrg) return null;
  const isCompact = variant === "compact";
  const canRenameTeam = role === "admin";
  const trimmedRenameDraft = renameDraft.trim();
  const renameDisabled =
    !trimmedRenameDraft || trimmedRenameDraft === currentOrg.displayName || renameMutation.isPending;

  return (
    <>
      <div ref={ref} className="relative" data-testid="team-switcher">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Switch team, current: ${currentOrg.displayName}`}
          onClick={() => setOpen((v) => !v)}
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
            cursor: "pointer",
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
            role="menu"
            // z-[46]: above the switch veil (45) so the in-menu spinner stays
            // visible during a switch, and above content overlays (conv-list /
            // right-rail z-30, doc drawer z-40); below dialogs (z-50).
            className="absolute left-0 z-[46] mt-2 overflow-hidden rounded-[var(--radius-panel)] border bg-popover shadow-[var(--shadow-md)]"
            style={{ width: 270, borderColor: "var(--border)" }}
          >
            {/* ① Current team header — always shown. */}
            <div className="border-b px-3.5 py-2.5" style={{ borderColor: "var(--border)" }}>
              <div className="flex items-start gap-2.5">
                <Avatar seed={currentOrg.id} name={currentOrg.displayName} size={26} />
                {renaming ? (
                  <form className="min-w-0 flex-1" onSubmit={handleRenameSubmit}>
                    <div className="flex items-center" style={{ gap: "var(--sp-1)" }}>
                      <input
                        ref={renameInputRef}
                        aria-label="Team name"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            cancelRenaming();
                          }
                        }}
                        disabled={renameMutation.isPending}
                        className="min-w-0 flex-1 rounded-[var(--radius-input)] border bg-[var(--bg)] px-2 py-1 text-body outline-none focus:border-[var(--border-strong)]"
                        style={{ borderColor: "var(--border)", color: "var(--fg)" }}
                        maxLength={200}
                      />
                      <button
                        type="submit"
                        aria-label="Save team name"
                        title="Save team name"
                        disabled={renameDisabled}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-input)] border transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                        style={{ borderColor: "var(--border)", color: "var(--fg)" }}
                      >
                        {renameMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        aria-label="Cancel team name edit"
                        title="Cancel"
                        disabled={renameMutation.isPending}
                        onClick={cancelRenaming}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-input)] border transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-45"
                        style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {renameMutation.error instanceof Error && (
                      <div className="text-label" style={{ marginTop: "var(--sp-1)", color: "var(--state-error)" }}>
                        {renameMutation.error.message}
                      </div>
                    )}
                  </form>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <div className="text-subtitle truncate" style={{ color: "var(--fg)" }}>
                        {currentOrg.displayName}
                      </div>
                      <div className="text-label truncate" style={{ color: "var(--fg-3)" }}>
                        {currentOrg.role} · current team{renameSaved ? " · Saved" : ""}
                      </div>
                    </div>
                    {canRenameTeam && (
                      <button
                        type="button"
                        aria-label="Edit team name"
                        title="Edit team name"
                        onClick={startRenaming}
                        className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-[var(--radius-input)] border transition-colors hover:bg-[var(--bg-hover)]"
                        style={{ borderColor: "var(--border)", color: "var(--fg-3)" }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* ② Switch list — other teams only; hidden for single-team users. */}
            {others.length > 0 && (
              <div className="border-b" style={{ borderColor: "var(--border)" }}>
                <div
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
                        disabled={!!switchingOrg}
                        aria-busy={isBusy}
                        onClick={() => void handleSwitch(o)}
                        className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-body transition-colors hover:bg-[var(--bg-hover)]"
                        style={{ color: "var(--fg)", opacity: switchingOrg && !isBusy ? 0.45 : undefined }}
                      >
                        <span className="inline-flex flex-none justify-center" style={{ width: 18 }}>
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Avatar seed={o.id} name={o.displayName} size={18} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{o.displayName}</span>
                        <RoleBadge role={o.role} dim />
                      </button>
                    );
                  })}
                </div>
                {switchError && (
                  <div
                    className="text-label"
                    style={{ padding: "var(--sp-1) var(--sp-3_5) var(--sp-1_5)", color: "var(--color-error)" }}
                  >
                    Couldn't switch — try again
                  </div>
                )}
              </div>
            )}

            {/* ③ Team management — always shown. */}
            <div className="py-1">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setSetupAction("create");
                }}
                className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-body transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--fg)" }}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Create new team</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setSetupAction("join");
                }}
                className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-body transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: "var(--fg)" }}
              >
                <UserPlus className="h-3.5 w-3.5" />
                <span>Join with invite link</span>
              </button>
              {/* Invite teammates — org-scoped link, so only when a team is
                  selected (mirrors the prior user-menu guard). */}
              {organizationId && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    setInviteOpen(true);
                  }}
                  className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-body transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ color: "var(--fg)" }}
                >
                  <Link2 className="h-3.5 w-3.5" />
                  <span>Invite teammates</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <TeamSetupModal action={setupAction} onClose={() => setSetupAction(null)} />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
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
        color: role === "admin" ? "var(--brand-dim)" : "var(--fg-3)",
        border: "var(--hairline) solid var(--border)",
        background: role === "admin" ? "var(--brand-bg)" : "var(--bg-sunken)",
        opacity: dim ? 0.7 : undefined,
      }}
    >
      {role}
    </span>
  );
}
