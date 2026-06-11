import type { Agent } from "@first-tree/shared";
import { Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  AgentDeleteConfirmDialog,
  AgentSuspendConfirmDialog,
} from "../../components/agent-lifecycle-confirm-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";

/**
 * Agent lifecycle — operational controls for availability and deletion.
 *
 * The section uses the same left label column as Identity so the page reads as
 * one settings surface. Red is reserved for the enabled destructive Delete
 * action; suspend/reactivate are reversible lifecycle actions and stay neutral.
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
    <div id="ad-danger" style={{ marginTop: "var(--sp-10)" }}>
      <Section
        title="Agent lifecycle"
        description="Manage availability and deletion. Lifecycle changes save immediately."
      >
        {agent.status === "active" ? (
          <DangerActionRow
            label="Availability"
            description="Active agents can bind to a runtime and receive routed messages."
            action={
              <Button
                variant="outline"
                size="sm"
                style={{ minWidth: "var(--sp-20)" }}
                onClick={() => setSuspendOpen(true)}
                disabled={props.suspendPending}
              >
                {props.suspendPending ? "Suspending…" : "Suspend"}
              </Button>
            }
          />
        ) : (
          <DangerActionRow
            label="Availability"
            description="Suspended agents cannot bind or receive routed messages."
            action={
              <Button
                variant="outline"
                size="sm"
                style={{ minWidth: "var(--sp-20)" }}
                onClick={props.onReactivate}
                disabled={props.reactivatePending}
              >
                {props.reactivatePending ? "Reactivating…" : "Reactivate"}
              </Button>
            }
          />
        )}
        <DangerActionRow
          label="Deletion"
          description={
            canDelete
              ? "Permanently remove configuration, bindings, tokens, and sessions."
              : "Available after the agent is suspended."
          }
          action={
            <Button
              variant={canDelete ? "destructive" : "outline"}
              size="sm"
              style={{ minWidth: "var(--sp-20)" }}
              onClick={() => {
                if (canDelete) setDeleteOpen(true);
              }}
              disabled={props.deletePending || !canDelete}
              title={canDelete ? undefined : "Suspend this agent before deleting it"}
            >
              {canDelete && <Trash2 className="h-3 w-3" />}
              {props.deletePending ? "Deleting…" : "Delete"}
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
    </div>
  );
}

function DangerActionRow({ label, description, action }: { label: string; description: ReactNode; action: ReactNode }) {
  return (
    <div
      className="grid grid-cols-1 gap-2 text-body md:grid-cols-[var(--agent-detail-label-col)_minmax(0,1fr)_auto] md:items-center md:gap-4"
      style={{
        padding: "var(--sp-3) 0",
        borderBottom: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div style={{ color: "var(--fg-3)" }}>{label}</div>
      <div className="text-caption" style={{ color: "var(--fg-4)" }}>
        {description}
      </div>
      <div className="md:justify-self-end">{action}</div>
    </div>
  );
}
