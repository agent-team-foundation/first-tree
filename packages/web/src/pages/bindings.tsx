import type { Agent } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { createAdapter, deleteAdapter, listAdapters, updateAdapter } from "../api/adapters.js";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Section } from "../components/ui/section.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { useOrgAgents } from "../lib/use-org-agents.js";
import { formatDate } from "../lib/utils.js";
import { BindingFormDialog, type BindingFormSubmit } from "./binding-form.js";

/**
 * Bindings page — manages Kael adapter (bot) bindings. Lives at
 * /integrations, with optional `?agent=<uuid>` filter so links from agent
 * detail can pre-scope the view to a single agent.
 */
export function BindingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentFilter = searchParams.get("agent");

  const resolveAgentName = useAgentNameMap();

  const adaptersQuery = useQuery({ queryKey: ["adapters"], queryFn: listAdapters });

  const agentsQuery = useOrgAgents();
  const allAgents = agentsQuery.data?.items ?? [];

  const adapters = useMemo(() => {
    const list = adaptersQuery.data ?? [];
    if (!agentFilter) return list;
    return list.filter((a) => a.agentId === agentFilter);
  }, [adaptersQuery.data, agentFilter]);

  const isLoading = adaptersQuery.isLoading;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAgentId, setPickerAgentId] = useState("");

  const [botDialog, setBotDialog] = useState<null | {
    agentId: string;
    editingId: number | null;
    initialStatus?: "active" | "inactive";
  }>(null);
  const [adapterToDelete, setAdapterToDelete] = useState<number | null>(null);

  const createAdapterMutation = useMutation({
    mutationFn: (vars: { agentId: string; status: "active" | "inactive"; credentials: Record<string, unknown> }) =>
      createAdapter({
        platform: "kael",
        agentId: vars.agentId,
        credentials: vars.credentials,
        status: vars.status,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapters"] });
      setBotDialog(null);
    },
  });

  const updateAdapterMutation = useMutation({
    mutationFn: (vars: { id: number; status: "active" | "inactive"; credentials?: Record<string, unknown> }) => {
      const data: Record<string, unknown> = { status: vars.status };
      if (vars.credentials) data.credentials = vars.credentials;
      return updateAdapter(vars.id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapters"] });
      setBotDialog(null);
    },
  });

  const deleteAdapterMutation = useMutation({
    mutationFn: deleteAdapter,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapters"] }),
  });

  function openCreate() {
    if (agentFilter) {
      setBotDialog({ agentId: agentFilter, editingId: null });
      return;
    }
    setPickerAgentId("");
    setPickerOpen(true);
  }
  function confirmPicker() {
    if (!pickerAgentId) return;
    setBotDialog({ agentId: pickerAgentId, editingId: null });
    setPickerOpen(false);
  }

  function handleBotSubmit(payload: BindingFormSubmit) {
    if (!botDialog) return;
    if (payload.kind === "create") {
      createAdapterMutation.mutate({
        agentId: botDialog.agentId,
        status: payload.draft.status,
        credentials: payload.draft.credentials,
      });
    } else if (payload.kind === "update") {
      if (!botDialog.editingId) return;
      updateAdapterMutation.mutate({
        id: botDialog.editingId,
        status: payload.status,
        credentials: payload.credentials,
      });
    }
  }

  const filterAgent = agentFilter ? allAgents.find((a) => a.uuid === agentFilter) : null;

  return (
    <>
      <p className="text-label" style={{ color: "var(--fg-3)", padding: "0 var(--sp-0_5) var(--sp-3)" }}>
        Manage Kael adapter bindings. Each binding holds the agent's encrypted Kael credentials used to forward outbound
        messages.
      </p>

      {agentFilter && (
        <div className="flex items-center gap-2" style={{ padding: "0 var(--sp-0_5) var(--sp-3)" }}>
          <span className="text-caption" style={{ color: "var(--fg-3)" }}>
            Filtered to
          </span>
          <span
            className="inline-flex items-center gap-1.5 mono text-caption"
            style={{
              padding: "var(--sp-0_5) var(--sp-2)",
              borderRadius: "var(--radius-chip)",
              background: "var(--bg-active)",
              border: "var(--hairline) solid var(--border)",
            }}
          >
            {filterAgent?.displayName ?? agentFilter}
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("agent");
                setSearchParams(next, { replace: true });
              }}
              aria-label="Clear filter"
              className="inline-flex items-center justify-center hover:bg-accent rounded-full"
              style={{ width: 14, height: 14, border: "none", background: "transparent", cursor: "pointer" }}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}

      <Section
        title="Bot bindings"
        count={adapters.length}
        action={
          <Button size="xs" variant="outline" onClick={openCreate}>
            <Plus className="h-3 w-3" /> Bot binding
          </Button>
        }
      >
        {isLoading ? (
          <EmptyRow>Loading…</EmptyRow>
        ) : !adapters.length ? (
          <EmptyRow>{agentFilter ? "No bot bindings for this agent yet." : "No bot bindings"}</EmptyRow>
        ) : (
          <DenseTable>
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead>Agent</DenseTableHead>
                <DenseTableHead>Platform</DenseTableHead>
                <DenseTableHead>Status</DenseTableHead>
                <DenseTableHead>Created</DenseTableHead>
                <DenseTableHead style={{ width: 96, textAlign: "right" }} />
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {adapters.map((a) => (
                <DenseTableRow key={a.id} interactive onClick={() => navigate(`/agents/${a.agentId}`)}>
                  <DenseTableCell>
                    <span className="mono font-medium" style={{ color: "var(--primary)" }}>
                      {resolveAgentName(a.agentId)}
                    </span>
                  </DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge>{humanizePlatform(a.platform)}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone={a.status === "active" ? "accent" : "outline"}>
                      {humanizeAdapterStatus(a.status)}
                    </DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                    {formatDate(a.createdAt)}
                  </DenseTableCell>
                  <DenseTableCell
                    style={{ textAlign: "right", whiteSpace: "nowrap" }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-label"
                      onClick={() =>
                        setBotDialog({
                          agentId: a.agentId,
                          editingId: a.id,
                          initialStatus: narrowStatus(a.status),
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setAdapterToDelete(a.id)}
                      disabled={deleteAdapterMutation.isPending}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </DenseTableCell>
                </DenseTableRow>
              ))}
            </DenseTableBody>
          </DenseTable>
        )}
      </Section>

      <AgentPickerDialog
        open={pickerOpen}
        agents={allAgents}
        agentId={pickerAgentId}
        onAgentChange={setPickerAgentId}
        onCancel={() => setPickerOpen(false)}
        onConfirm={confirmPicker}
      />

      <BindingFormDialog
        open={botDialog != null}
        editingId={botDialog?.editingId ?? null}
        initialStatus={botDialog?.initialStatus}
        agentLabel={botDialog ? resolveAgentName(botDialog.agentId) : ""}
        pending={createAdapterMutation.isPending || updateAdapterMutation.isPending}
        errorMessage={
          (createAdapterMutation.error ?? updateAdapterMutation.error) instanceof Error
            ? ((createAdapterMutation.error ?? updateAdapterMutation.error) as Error).message
            : null
        }
        onOpenChange={(open) => {
          if (!open) {
            setBotDialog(null);
            createAdapterMutation.reset();
            updateAdapterMutation.reset();
          }
        }}
        onSubmit={handleBotSubmit}
      />

      <ConfirmDialog
        open={adapterToDelete != null}
        onOpenChange={(o) => !o && setAdapterToDelete(null)}
        title="Remove this bot binding?"
        description="The bot will stop routing to this agent and any platform credentials stored here will be dropped."
        confirmLabel="Remove binding"
        pending={deleteAdapterMutation.isPending}
        onConfirm={() => {
          if (adapterToDelete != null) {
            deleteAdapterMutation.mutate(adapterToDelete);
            setAdapterToDelete(null);
          }
        }}
      />
    </>
  );
}

function narrowStatus(s: string): "active" | "inactive" {
  return s === "inactive" ? "inactive" : "active";
}

function humanizePlatform(platform: string): string {
  if (platform === "kael") return "Kael";
  return platform;
}

function humanizeAdapterStatus(status: string): string {
  switch (status) {
    case "active":
      return "Active";
    case "inactive":
      return "Inactive";
    default:
      return status;
  }
}

function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div className="text-center py-6 text-body" style={{ color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}

function AgentPickerDialog(props: {
  open: boolean;
  agents: Agent[];
  agentId: string;
  onAgentChange: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const candidates = props.agents.filter((a) => a.type !== "human" && a.status === "active");

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bind a bot</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-body" style={{ color: "var(--fg-3)" }}>
            Pick the agent this binding routes to.
          </p>
          <select
            value={props.agentId}
            onChange={(e) => props.onAgentChange(e.target.value)}
            className="flex h-9 w-full rounded-[var(--radius-input)] border border-input bg-transparent px-3 py-1 text-body shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="">Select an agent…</option>
            {candidates.map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.displayName} {a.name ? `(@${a.name})` : ""}
              </option>
            ))}
          </select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button onClick={props.onConfirm} disabled={!props.agentId}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-body" style={{ color: "var(--fg-2)" }}>
          {props.description}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)} disabled={props.pending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={props.onConfirm} disabled={props.pending}>
            {props.pending ? "Working…" : props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
