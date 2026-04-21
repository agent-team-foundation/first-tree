import { MEMBER_ROLES } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { createMember, deleteMember, listMembers, updateMember } from "../api/members.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { formatDate } from "../lib/utils.js";

const roleValues = Object.values(MEMBER_ROLES);

type MemberRow = {
  id: string;
  username: string;
  displayName: string;
  role: string;
};

export function MembersPage() {
  const queryClient = useQueryClient();
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
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Members</h1>
        <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Member
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{createdPassword ? "Member Created" : "Create Member"}</DialogTitle>
            </DialogHeader>
            {createdPassword ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Member created. Share the password below — it will only be shown once.
                </p>
                <div className="flex items-center gap-2 rounded-md border p-3 bg-muted">
                  <code className="flex-1 text-sm font-mono">{createdPassword}</code>
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
                  <div className="text-sm text-destructive">{createMut.error.message}</div>
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
      </div>

      <EditMemberDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          setEditTarget(null);
          queryClient.invalidateQueries({ queryKey: ["members"] });
        }}
      />

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-destructive">
                  Failed to load members: {error instanceof Error ? error.message : "Unknown error"}
                </TableCell>
              </TableRow>
            ) : members?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  No members
                </TableCell>
              </TableRow>
            ) : (
              members?.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.username}</TableCell>
                  <TableCell>{m.displayName}</TableCell>
                  <TableCell>
                    <Badge variant={m.role === "admin" ? "default" : "secondary"}>{m.role}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(m.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
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
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(m.id)}
                        disabled={deleteMut.isPending}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
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
              <p className="text-xs text-muted-foreground">Username is permanent after creation.</p>
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
              <p className="text-xs text-muted-foreground">
                Demoting the last admin is blocked — every org needs at least one admin to manage members.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
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
