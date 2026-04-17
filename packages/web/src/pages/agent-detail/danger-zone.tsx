import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { AlertTriangle, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";

/**
 * Redesign §5.8 Danger Zone — visually isolated, GitHub-style confirm for delete.
 */

export type DangerZoneProps = {
  agent: Agent;
  suspendPending: boolean;
  reactivatePending: boolean;
  deletePending: boolean;
  onSuspend: () => void;
  onReactivate: () => void;
  onDelete: () => void;
};

export function DangerZone(props: DangerZoneProps) {
  const { agent } = props;
  const [deleteOpen, setDeleteOpen] = useState(false);

  const displayLabel = agent.displayName || agent.name || agent.uuid;

  return (
    <section className="rounded-md border border-red-200 bg-red-50/40">
      <header className="flex items-center gap-2 border-b border-red-200 px-4 py-2">
        <AlertTriangle className="h-4 w-4 text-red-700" />
        <h3 className="text-sm font-medium text-red-800">Danger Zone</h3>
      </header>
      <div className="divide-y divide-red-200">
        {agent.status === "active" ? (
          <DangerRow
            title="Suspend agent"
            body="Pause all active sessions. You can reactivate later; tokens stay revoked until then."
            action={
              <Button variant="outline" size="sm" onClick={props.onSuspend} disabled={props.suspendPending}>
                {props.suspendPending ? "Suspending…" : "Suspend"}
              </Button>
            }
          />
        ) : (
          <DangerRow
            title="Reactivate agent"
            body="Resume sessions. Tokens must be recreated — they are not restored."
            action={
              <Button variant="outline" size="sm" onClick={props.onReactivate} disabled={props.reactivatePending}>
                {props.reactivatePending ? "Reactivating…" : "Reactivate"}
              </Button>
            }
          />
        )}
        <DangerRow
          title="Delete agent"
          body="Permanent. Configuration, bindings, tokens, and session history are all dropped."
          action={
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={props.deletePending}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              Delete
            </Button>
          }
        />
      </div>

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        expected={displayLabel}
        onDelete={() => {
          setDeleteOpen(false);
          props.onDelete();
        }}
        deleting={props.deletePending}
      />
    </section>
  );
}

function DangerRow(props: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
      <div>
        <p className="font-medium text-red-900">{props.title}</p>
        <p className="text-xs text-red-800/80">{props.body}</p>
      </div>
      <div>{props.action}</div>
    </div>
  );
}

type DeleteConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  expected: string;
  onDelete: () => void;
  deleting: boolean;
};

function DeleteConfirmDialog({ open, onOpenChange, expected, onDelete, deleting }: DeleteConfirmProps) {
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
          <p className="text-sm text-muted-foreground">
            This action cannot be undone. Type <span className="font-mono font-medium text-gray-900">{expected}</span>{" "}
            to confirm.
          </p>
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
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
