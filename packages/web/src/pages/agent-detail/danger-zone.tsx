import type { Agent } from "@first-tree/shared";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import {
  AgentDeleteConfirmDialog,
  AgentSuspendConfirmDialog,
} from "../../components/agent-lifecycle-confirm-dialog.js";
import { Button } from "../../components/ui/button.js";
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
            description="Stop the connected runtime and prevent new messages from waking this agent until it is reactivated."
            action={
              <Button variant="outline" size="xs" onClick={() => setSuspendOpen(true)} disabled={props.suspendPending}>
                {props.suspendPending ? "Suspending…" : "Suspend"}
              </Button>
            }
          />
        ) : (
          <ConfigRow
            label="Reactivate agent"
            description="Allow this agent to bind again and receive new routed messages."
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

      <AgentSuspendConfirmDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        label={displayLabel}
        onConfirm={() => {
          setSuspendOpen(false);
          props.onSuspend();
        }}
        pending={props.suspendPending}
      />
      <AgentDeleteConfirmDialog
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
