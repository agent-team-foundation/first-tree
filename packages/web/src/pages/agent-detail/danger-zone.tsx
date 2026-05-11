import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { AlertTriangle, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";

/**
 * Redesign §5.8 Danger Zone — visually isolated, GitHub-style confirm for delete.
 * Suspend also uses a proper Dialog (no native window.confirm).
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
  const [suspendOpen, setSuspendOpen] = useState(false);

  const displayLabel = agent.displayName || agent.name || agent.uuid;

  return (
    <section
      id="ad-danger"
      style={{
        background: "color-mix(in oklch, var(--state-error) 6%, var(--bg-raised))",
        border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
        borderRadius: "var(--radius-panel)",
      }}
    >
      <header className="flex items-center gap-2" style={{ padding: "var(--sp-2_5) var(--sp-3_5)" }}>
        <AlertTriangle className="h-3.5 w-3.5" style={{ color: "var(--state-error)" }} />
        <h3 className="text-body font-semibold" style={{ color: "var(--state-error)" }}>
          Danger zone
        </h3>
      </header>
      <div>
        {agent.status === "active" ? (
          <DangerRow
            title="Suspend agent"
            body="Pause all active sessions. You can reactivate later; tokens stay revoked until then."
            action={
              <Button variant="outline" size="xs" onClick={() => setSuspendOpen(true)} disabled={props.suspendPending}>
                {props.suspendPending ? "Suspending…" : "Suspend"}
              </Button>
            }
          />
        ) : (
          <DangerRow
            title="Reactivate agent"
            body="Resume sessions. Tokens must be recreated — they are not restored."
            action={
              <Button variant="outline" size="xs" onClick={props.onReactivate} disabled={props.reactivatePending}>
                {props.reactivatePending ? "Reactivating…" : "Reactivate"}
              </Button>
            }
          />
        )}
        <DangerRow
          title="Delete agent"
          body="Permanent. Configuration, bindings, tokens, and session history are all dropped."
          action={
            <Button variant="destructive" size="xs" onClick={() => setDeleteOpen(true)} disabled={props.deletePending}>
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          }
        />
      </div>

      <SuspendConfirmDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        label={displayLabel}
        onConfirm={() => {
          setSuspendOpen(false);
          props.onSuspend();
        }}
        pending={props.suspendPending}
      />
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
    <div
      className="flex items-start justify-between gap-4 text-body"
      style={{
        padding: "var(--sp-2_5) var(--sp-3_5)",
        borderTop: "var(--hairline) solid color-mix(in oklch, var(--state-error) 14%, transparent)",
      }}
    >
      <div>
        <p className="font-medium" style={{ color: "var(--fg)" }}>
          {props.title}
        </p>
        <p className="text-label font-normal" style={{ color: "var(--fg-3)" }}>
          {props.body}
        </p>
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

type SuspendConfirmProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  onConfirm: () => void;
  pending: boolean;
};

function SuspendConfirmDialog({ open, onOpenChange, label, onConfirm, pending }: SuspendConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend "{label}"?</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-body" style={{ color: "var(--fg-2)" }}>
            Runtime binds and HTTP calls will be refused while the agent is suspended. Active sessions end on their next
            message. You can reactivate later from this same page.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? "Suspending…" : "Suspend"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
          <p className="text-body text-muted-foreground">
            This action cannot be undone. Type <span className="font-mono font-medium text-foreground">{expected}</span>{" "}
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
