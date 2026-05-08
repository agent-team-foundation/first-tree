import { MEMBER_ROLES } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { deleteMember, listMembers, updateMember } from "../api/members.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import {
  DenseTable,
  DenseTableBody,
  DenseTableCell,
  DenseTableHead,
  DenseTableHeader,
  DenseTableRow,
} from "../components/ui/dense-table.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { formatDay } from "../lib/utils.js";

const roleValues = Object.values(MEMBER_ROLES);

type MemberRow = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};

/**
 * Members table — view, edit role / display name, remove. New members join
 * via the Invite link flow (admin-only button on /team); the legacy
 * username/password create path was retired with the org-decoupled auth
 * refactor.
 */
export function MembersPage() {
  const queryClient = useQueryClient();
  const { memberId: selfId, role } = useAuth();
  const isAdmin = role === "admin";
  const [editTarget, setEditTarget] = useState<MemberRow | null>(null);

  const {
    data: members,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["members"],
    queryFn: listMembers,
  });

  const deleteMut = useMutation({
    mutationFn: deleteMember,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members"] }),
  });

  function handleDelete(id: string) {
    if (window.confirm("Delete this member? Their human agent will also be deactivated.")) {
      deleteMut.mutate(id);
    }
  }

  return (
    <>
      <section>
        {isLoading ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : error ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--state-error)" }}>
            Failed to load members: {error instanceof Error ? error.message : "Unknown error"}
          </div>
        ) : members?.length === 0 ? (
          <div className="text-center py-8 text-body" style={{ color: "var(--fg-3)" }}>
            {isAdmin ? "No members yet — share the Invite link to add teammates." : "No members yet."}
          </div>
        ) : (
          <DenseTable className="table-fixed">
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead style={{ width: 160 }}>Display name</DenseTableHead>
                <DenseTableHead style={{ width: 140 }}>Username</DenseTableHead>
                <DenseTableHead style={{ width: 120 }}>Role</DenseTableHead>
                <DenseTableHead style={{ width: 150 }}>Created</DenseTableHead>
                <DenseTableHead aria-hidden />
                {isAdmin && <DenseTableHead style={{ width: 80, textAlign: "right" }} />}
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {members?.map((m) => {
                const isSelf = selfId === m.id;
                return (
                  <DenseTableRow key={m.id}>
                    <DenseTableCell>
                      <span className="font-medium">{m.displayName}</span>
                      {isSelf && (
                        <span className="text-label italic" style={{ marginLeft: 6, color: "var(--fg-3)" }}>
                          (you)
                        </span>
                      )}
                    </DenseTableCell>
                    <DenseTableCell>
                      <span className="mono text-label" style={{ color: "var(--fg-3)" }}>
                        @{m.username}
                      </span>
                    </DenseTableCell>
                    <DenseTableCell className="text-label" style={{ color: "var(--fg-3)" }}>
                      {m.role === "admin" ? "Admin" : "Member"}
                    </DenseTableCell>
                    <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                      {formatDay(m.createdAt)}
                    </DenseTableCell>
                    <DenseTableCell aria-hidden />
                    {isAdmin && (
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
                          {!isSelf && (
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
                          )}
                        </div>
                      </DenseTableCell>
                    )}
                  </DenseTableRow>
                );
              })}
            </DenseTableBody>
          </DenseTable>
        )}
      </section>

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
              <p className="text-caption" style={{ color: "var(--fg-3)" }}>
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
                className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {roleValues.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <p className="text-caption" style={{ color: "var(--fg-3)" }}>
                Demoting the last admin is blocked — every org needs at least one admin to manage members.
              </p>
            </div>
            {error && (
              <p className="text-body" style={{ color: "var(--state-error)" }}>
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
