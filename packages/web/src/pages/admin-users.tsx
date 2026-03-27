import { ADMIN_ROLES } from "@first-tree-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { createAdminUser, deleteAdminUser, listAdminUsers, updateAdminUser } from "../api/admin-users.js";
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

const roleValues = Object.values(ADMIN_ROLES);

type DialogMode = "create" | "edit" | "reset-password";

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode>("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "admin" });

  const {
    data: users,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["admin-users"],
    queryFn: listAdminUsers,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createAdminUser({
        username: form.username,
        password: form.password,
        role: form.role as "super_admin" | "admin",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      closeDialog();
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editingId) throw new Error("No user selected");
      const data: Record<string, unknown> = {};
      if (dialogMode === "edit") data.role = form.role;
      if (dialogMode === "reset-password") data.password = form.password;
      return updateAdminUser(editingId, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      closeDialog();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAdminUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-users"] }),
  });

  function closeDialog() {
    setDialogOpen(false);
    setDialogMode("create");
    setEditingId(null);
    setForm({ username: "", password: "", role: "admin" });
  }

  function openEdit(user: { id: string; role: string }) {
    setEditingId(user.id);
    setDialogMode("edit");
    setForm({ username: "", password: "", role: user.role });
    setDialogOpen(true);
  }

  function openResetPassword(id: string) {
    setEditingId(id);
    setDialogMode("reset-password");
    setForm({ username: "", password: "", role: "admin" });
    setDialogOpen(true);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (dialogMode === "create") {
      createMutation.mutate();
    } else {
      updateMutation.mutate();
    }
  }

  function handleDelete(id: string) {
    if (window.confirm("Delete this admin user?")) {
      deleteMutation.mutate(id);
    }
  }

  const mutationError = createMutation.error ?? updateMutation.error;
  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Admin Users</h1>
        <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
          <DialogTrigger asChild>
            <Button onClick={() => setDialogMode("create")}>
              <Plus className="h-4 w-4 mr-2" />
              Add Admin
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {dialogMode === "create" ? "Create Admin User" : dialogMode === "edit" ? "Edit Role" : "Reset Password"}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              {dialogMode === "create" && (
                <div className="space-y-2">
                  <Label htmlFor="admin-username">Username</Label>
                  <Input
                    id="admin-username"
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    required
                  />
                </div>
              )}
              {(dialogMode === "create" || dialogMode === "reset-password") && (
                <div className="space-y-2">
                  <Label htmlFor="admin-password">Password</Label>
                  <Input
                    id="admin-password"
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                    minLength={8}
                  />
                </div>
              )}
              {(dialogMode === "create" || dialogMode === "edit") && (
                <div className="space-y-2">
                  <Label htmlFor="admin-role">Role</Label>
                  <select
                    id="admin-role"
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
              )}
              {mutationError instanceof Error && (
                <div className="text-sm text-destructive">{mutationError.message}</div>
              )}
              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last Login</TableHead>
              <TableHead className="w-32" />
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
                  Failed to load admin users: {error instanceof Error ? error.message : "Unknown error"}
                </TableCell>
              </TableRow>
            ) : users?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  No admin users
                </TableCell>
              </TableRow>
            ) : (
              users?.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.username}</TableCell>
                  <TableCell>
                    <Badge variant={u.role === "super_admin" ? "default" : "secondary"}>{u.role}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(u.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(u.lastLoginAt)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(u)} title="Edit role">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openResetPassword(u.id)} title="Reset password">
                        Reset PW
                      </Button>
                      {u.role !== "super_admin" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(u.id)}
                          disabled={deleteMutation.isPending}
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
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
