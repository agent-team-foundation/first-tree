import { type FormEvent, useState } from "react";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";

export function AgentSuspendConfirmDialog({
  open,
  onOpenChange,
  label,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend "{label}"?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <DialogDescription style={{ color: "var(--fg-2)" }}>
            This disables the agent until it is reactivated.
          </DialogDescription>
          <p className="text-body" style={{ color: "var(--fg-2)" }}>
            Its runtime will be stopped and unbound from the connected computer. New messages and mentions will not wake
            it while suspended. Existing configuration, workspace, chat history, and saved sessions are kept.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending}>
            {pending ? "Suspending…" : "Suspend agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AgentDeleteConfirmDialog({
  open,
  onOpenChange,
  expected,
  onDelete,
  deleting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expected: string;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [typed, setTyped] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    if (typed === expected) onDelete();
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTyped("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete "{expected}"?</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <DialogDescription>
            This cannot be undone. It permanently removes configuration, bindings, tokens, and sessions. Type{" "}
            <span className="font-mono font-medium text-foreground">{expected}</span> to confirm.
          </DialogDescription>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            placeholder={expected}
            className="font-mono"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={typed !== expected || deleting}>
              {deleting ? "Deleting…" : "Delete agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
