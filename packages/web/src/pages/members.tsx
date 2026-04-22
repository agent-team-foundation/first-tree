import { MEMBER_ROLES } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { createMember, deleteMember, listMembers, updateMember } from "../api/members.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { DenseBadge } from "../components/ui/dense-badge.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../components/ui/dense-table.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Panel } from "../components/ui/panel.js";
import { SectionHeader, UppercaseLabel } from "../components/ui/section-header.js";
import { formatDate } from "../lib/utils.js";

const roleValues = Object.values(MEMBER_ROLES);

type MemberRow = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};

function initials(displayName: string, username: string): string {
  const source = displayName?.trim() || username;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0] ?? "";
    const second = parts[1] ?? "";
    return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

export function MembersPage() {
  const queryClient = useQueryClient();
  const { memberId: selfId } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", role: "member" });
  const [createdPassword, setCreatedPassword] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<MemberRow | null>(null);

  const {
    data: members,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["members"],
    queryFn: listMembers,
  });

  const createMut = useMutation({
    mutationFn: () =>
      createMember({
        username: form.username,
        displayName: form.displayName,
        role: form.role as "admin" | "member",
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["members"] });
      setCreatedPassword(data.password);
    },
  });

  const deleteMut = useMutation({
    mutationFn: deleteMember,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
  });

  function closeDialog() {
    setDialogOpen(false);
    setForm({ username: "", displayName: "", role: "member" });
    setCreatedPassword(null);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    createMut.mutate();
  }

  function handleDelete(id: string) {
    if (window.confirm("Delete this member? Their human agent will also be deactivated.")) {
      deleteMut.mutate(id);
    }
  }

  return (
    <>
      <Panel>
        <SectionHeader
          right={
            <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
              <DialogTrigger asChild>
                <Button size="xs" className="normal-case tracking-normal">
                  <Plus className="h-3 w-3" />
                  Add member
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{createdPassword ? "Member Created" : "Create Member"}</DialogTitle>
                </DialogHeader>
                {createdPassword ? (
                  <div className="space-y-4">
                    <p className="text-sm" style={{ color: "var(--fg-3)" }}>
                      Member created. Share the password below — it will only be shown once.
                    </p>
                    <div
                      className="flex items-center gap-2 rounded-md p-3"
                      style={{ background: "var(--bg-sunken)", border: "1px solid var(--border-faint)" }}
                    >
                      <code className="flex-1 text-sm mono">{createdPassword}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigator.clipboard.writeText(createdPassword)}
                        title="Copy password"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                    <DialogFooter>
                      <Button onClick={closeDialog}>Done</Button>
                    </DialogFooter>
                  </div>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="member-username">Username</Label>
                      <Input
                        id="member-username"
                        type="text"
                        value={form.username}
                        onChange={(e) => setForm({ ...form, username: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="member-name">Display Name</Label>
                      <Input
                        id="member-name"
                        value={form.displayName}
                        onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="member-role">Role</Label>
                      <select
                        id="member-role"
                        value={form.role}
                        onChange={(e) => setForm({ ...form, role: e.target.value })}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        {roleValues.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                    {createMut.error instanceof Error && (
                      <div className="text-sm" style={{ color: "var(--state-error)" }}>
                        {createMut.error.message}
                      </div>
                    )}
                    <DialogFooter>
                      <Button type="submit" disabled={createMut.isPending}>
                        {createMut.isPending ? "Creating..." : "Create"}
                      </Button>
                    </DialogFooter>
                  </form>
                )}
              </DialogContent>
            </Dialog>
          }
        >
          Members · {members?.length ?? 0}
        </SectionHeader>

        {isLoading ? (
          <div className="text-center py-8" style={{ color: "var(--fg-3)", fontSize: 12 }}>
            Loading…
          </div>
        ) : error ? (
          <div className="text-center py-8" style={{ color: "var(--state-error)", fontSize: 12 }}>
            Failed to load members: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        ) : members?.length === 0 ? (
          <div className="text-center py-8" style={{ color: "var(--fg-3)", fontSize: 12 }}>
            No members
          </div>
        ) : (
          <DenseTable>
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead style={{ width: 30 }} />
                <DenseTableHead>Username</DenseTableHead>
                <DenseTableHead>Name</DenseTableHead>
                <DenseTableHead>Role</DenseTableHead>
                <DenseTableHead>Created</DenseTableHead>
                <DenseTableHead style={{ width: 1 }} />
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {members?.map((m) => {
                const isSelf = selfId === m.id;
                return (
                  <DenseTableRow key={m.id}>
                    <DenseTableCell>
                      <span
                        className="mono inline-flex items-center justify-center"
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          background: isSelf ? "var(--accent-bg)" : "var(--bg-active)",
                          border: "1px solid var(--border-strong)",
                          fontSize: 9.5,
                          fontWeight: 600,
                          color: isSelf ? "var(--accent-dim)" : "var(--fg-2)",
                        }}
                      >
                        {initials(m.displayName, m.username)}
                      </span>
                    </DenseTableCell>
                    <DenseTableCell>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>
                        {m.username}
                      </span>
                      {isSelf && <UppercaseLabel style={{ marginLeft: 6 }}>you</UppercaseLabel>}
                    </DenseTableCell>
                    <DenseTableCell style={{ color: "var(--fg-2)" }}>{m.displayName}</DenseTableCell>
                    <DenseTableCell>
                      <DenseBadge tone={m.role === "admin" ? "accent" : "neutral"}>{m.role}</DenseBadge>
                    </DenseTableCell>
                    <DenseTableCell className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
                      {formatDate(m.createdAt)}
                    </DenseTableCell>
                    <DenseTableCell style={{ whiteSpace: "nowrap" }}>
                      <div className="flex gap-0.5 justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setEditTarget({
                              id: m.id,
                              username: m.username,
                              displayName: m.displayName,
                              role: m.role,
                            })
                          }
                          title="Edit"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleDelete(m.id)}
                          disabled={deleteMut.isPending}
                          title="Delete"
                          style={{ color: "var(--fg-4)" }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </DenseTableCell>
                  </DenseTableRow>
                );
              })}
            </DenseTableBody>
          </DenseTable>
        )}
      </Panel>

      <EditMemberDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          queryClient.invalidateQueries({ queryKey: ["members"] });
        }}
      />
    </>
  );
}

function EditMemberDialog({
  target,
  onClose,
  onSaved,
}: {
  target: MemberRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<string>("member");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setDisplayName(target.displayName);
      setRole(target.role);
      setError(null);
    }
  }, [target]);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("No target");
      const patch: { displayName?: string; role?: "admin" | "member" } = {};
      if (displayName.trim() && displayName !== target.displayName) {
        patch.displayName = displayName.trim();
      }
      if (role !== target.role) {
        patch.role = role as "admin" | "member";
      }
      if (Object.keys(patch).length === 0) return target;
      return updateMember(target.id, patch);
    },
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    saveMut.mutate();
  }

  const open = target !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Member</DialogTitle>
        </DialogHeader>
        {target && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input value={target.username} disabled className="font-mono" />
              <p className="text-xs" style={{ color: "var(--fg-3)" }}>
                Username is permanent after creation.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-member-display">Display Name</Label>
              <Input
                id="edit-member-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-member-role">Role</Label>
              <select
                id="edit-member-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {roleValues.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <p className="text-xs" style={{ color: "var(--fg-3)" }}>
                Demoting the last admin is blocked — every org needs at least one admin to manage members.
              </p>
            </div>
            {error && (
              <p className="text-sm" style={{ color: "var(--state-error)" }}>
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose} disabled={saveMut.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={saveMut.isPending}>
                {saveMut.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
