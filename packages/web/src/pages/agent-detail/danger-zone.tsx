import type { Agent } from "@agent-team-foundation/first-tree-hub-shared";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Section } from "../../components/ui/section.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Danger Zone — destructive lifecycle controls (suspend / reactivate / delete).
 *
 * Visual: shares the flat Section / ConfigRow rhythm with the rest of
 * Setup tab. The danger framing comes from the red section title and the
 * destructive Delete button, not from a coloured panel — the older red-tinted
 * card stood out so hard it looked detached from the rest of the page.
 *
 * Confirmation uses real Dialogs (no native window.confirm) so both Suspend
 * and Delete can render typed-name confirmation copy and a labelled button.
 */

export type DangerZoneProps = {
  agent: Agent;
  suspendPending: boolean;
  reactivatePending: boolean;
  deletePending: boolean;
  errorMessage?: string | null;
  onSuspend: () => void;
  onReactivate: () => void;
  onDelete: () => void;
};

export function DangerZone(props: DangerZoneProps) {
  const { agent } = props;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);

  const displayLabel = agent.displayName || agent.name || agent.uuid;
  const canDelete = agent.status === "suspended";

  return (
    <section id="ad-danger">
      <Section title={<span style={{ color: "var(--state-error)" }}>Danger zone</span>}>
        {agent.status === "active" ? (
          <ConfigRow
            label="Suspend agent"
            description="Pause all active sessions. You can reactivate later; tokens stay revoked until then."
            action={
              <Button variant="outline" size="xs" onClick={() => setSuspendOpen(true)} disabled={props.suspendPending}>
                {props.suspendPending ? "Suspending…" : "Suspend"}
              </Button>
            }
          />
        ) : (
          <ConfigRow
            label="Reactivate agent"
            description="Resume sessions. Tokens must be recreated — they are not restored."
            action={
              <Button variant="outline" size="xs" onClick={props.onReactivate} disabled={props.reactivatePending}>
                {props.reactivatePending ? "Reactivating…" : "Reactivate"}
              </Button>
            }
          />
        )}
        <ConfigRow
          label="Delete agent"
          description={
            canDelete
              ? "Permanent. Configuration, bindings, tokens, and session history are all dropped."
              : "Suspend this agent before deleting it."
          }
          action={
            <Button
              variant="destructive"
              size="xs"
              onClick={() => {
                if (canDelete) setDeleteOpen(true);
              }}
              disabled={props.deletePending || !canDelete}
              title={canDelete ? undefined : "Suspend this agent before deleting it"}
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          }
        />
        {props.errorMessage && (
          <p className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
            {props.errorMessage}
          </p>
        )}
      </Section>

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
