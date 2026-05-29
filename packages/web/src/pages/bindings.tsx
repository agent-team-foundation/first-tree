import type { AdapterBotStatus, Agent } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { createAdapterMapping, deleteAdapterMapping, listAdapterMappings } from "../api/adapter-mappings.js";
import { getAdapterStatuses } from "../api/adapter-status.js";
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
import { PresenceChip } from "../components/ui/presence-chip.js";
import { Section } from "../components/ui/section.js";
import { useAgentNameMap } from "../lib/use-agent-name-map.js";
import { useOrgAgents } from "../lib/use-org-agents.js";
import { formatDate } from "../lib/utils.js";
import { BindingFormDialog, type BindingFormSubmit } from "./binding-form.js";

/**
 * Bindings page — single source of truth for managing adapter (bot) and
 * adapter-mapping (user) bindings. Lives at /integrations,
 * with optional `?agent=<uuid>` filter so links from agent detail can
 * pre-scope the view to a single agent.
 *
 * Why centralized here (vs. on agent detail): bindings are a server-level
 * concern (the Hub server is the one that receives Feishu/Slack webhooks
 * and routes them to agent inboxes; the client computer never holds these
 * credentials). Surfacing CRUD here keeps the agent detail page focused on
 * "how this agent thinks/acts" while letting integrations admins find one
 * place for all platform plumbing.
 */
export function BindingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const agentFilter = searchParams.get("agent");

  const resolveAgentName = useAgentNameMap();

  const adaptersQuery = useQuery({ queryKey: ["adapters"], queryFn: listAdapters });
  const mappingsQuery = useQuery({ queryKey: ["adapter-mappings"], queryFn: listAdapterMappings });
  const botStatusQuery = useQuery({
    queryKey: ["adapter-statuses"],
    queryFn: getAdapterStatuses,
    refetchInterval: 15_000,
  });

  // We need the full agent list for two reasons: (1) the "+ Bot binding" /
  // "+ User binding" pickers, and (2) the filter chip at the top of the page.
  // Shared with `useAgentNameMap` (and the chat picker) via `useOrgAgents`
  // so all three surfaces hit one cache and one HTTP fetch per refetch tick.
  const agentsQuery = useOrgAgents();
  const allAgents = agentsQuery.data?.items ?? [];

  // Status lookup: fast O(1) check whether an adapter row's bot is online.
  const statusByConfigId = useMemo(() => {
    const map = new Map<number, AdapterBotStatus>();
    for (const s of botStatusQuery.data ?? []) map.set(s.configId, s);
    return map;
  }, [botStatusQuery.data]);

  // Apply the optional `?agent=` filter. `null` = no filter; everything below
  // funnels through these two filtered arrays so the count badges and table
  // bodies stay consistent.
  const adapters = useMemo(() => {
    const list = adaptersQuery.data ?? [];
    if (!agentFilter) return list;
    return list.filter((a) => a.agentId === agentFilter);
  }, [adaptersQuery.data, agentFilter]);

  const mappings = useMemo(() => {
    const list = mappingsQuery.data ?? [];
    if (!agentFilter) return list;
    return list.filter((m) => m.agentId === agentFilter);
  }, [mappingsQuery.data, agentFilter]);

  const onlineBots = adapters.reduce((n, a) => n + (statusByConfigId.get(a.id)?.connected ? 1 : 0), 0);
  const offlineBots = adapters.length - onlineBots;

  const isLoading = adaptersQuery.isLoading || mappingsQuery.isLoading;

  // ── Pickers / dialogs state ────────────────────────────────────────────
  // Picker = "which agent is this binding for?" — only shown when no
  // `?agent=` filter is in effect. Otherwise we use the filter directly and
  // skip straight to the credentials form.
  const [pickerOpen, setPickerOpen] = useState<null | { kind: "bot" | "user" }>(null);
  const [pickerAgentId, setPickerAgentId] = useState("");

  const [botDialog, setBotDialog] = useState<null | {
    agentId: string;
    editingId: number | null;
    initialPlatform?: "feishu" | "slack" | "kael";
    initialStatus?: "active" | "inactive";
  }>(null);
  const [userDialog, setUserDialog] = useState<null | { agentId: string }>(null);
  const [adapterToDelete, setAdapterToDelete] = useState<number | null>(null);
  const [mappingToDelete, setMappingToDelete] = useState<number | null>(null);

  // ── Mutations ──────────────────────────────────────────────────────────
  const createAdapterMutation = useMutation({
    mutationFn: (vars: {
      agentId: string;
      platform: "feishu" | "slack" | "kael";
      status: "active" | "inactive";
      credentials: Record<string, unknown>;
    }) =>
      createAdapter({
        platform: vars.platform,
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

  const createMappingMutation = useMutation({
    mutationFn: (vars: {
      agentId: string;
      platform: "feishu" | "slack" | "kael";
      externalUserId: string;
      displayName: string | null;
    }) =>
      createAdapterMapping({
        platform: vars.platform,
        externalUserId: vars.externalUserId,
        agentId: vars.agentId,
        boundVia: "manual",
        displayName: vars.displayName ?? undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adapter-mappings"] });
      setUserDialog(null);
    },
  });

  const deleteMappingMutation = useMutation({
    mutationFn: deleteAdapterMapping,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["adapter-mappings"] }),
  });

  // ── Pick-an-agent ↔ open-the-real-form bridge ─────────────────────────
  // When a `?agent=` filter is in effect, "+ binding" goes straight to the
  // credentials dialog. Without a filter, we step through a small picker
  // first so the operator commits to a target agent before typing secrets.
  function openCreate(kind: "bot" | "user") {
    if (agentFilter) {
      if (kind === "bot") setBotDialog({ agentId: agentFilter, editingId: null });
      else setUserDialog({ agentId: agentFilter });
      return;
    }
    setPickerAgentId("");
    setPickerOpen({ kind });
  }
  function confirmPicker() {
    if (!pickerOpen || !pickerAgentId) return;
    if (pickerOpen.kind === "bot") setBotDialog({ agentId: pickerAgentId, editingId: null });
    else setUserDialog({ agentId: pickerAgentId });
    setPickerOpen(null);
  }

  function handleBotSubmit(payload: BindingFormSubmit) {
    if (!botDialog) return;
    if (payload.kind === "bot-create") {
      createAdapterMutation.mutate({
        agentId: botDialog.agentId,
        platform: payload.draft.platform,
        status: payload.draft.status,
        credentials: payload.draft.credentials,
      });
    } else if (payload.kind === "bot-update") {
      if (!botDialog.editingId) return;
      updateAdapterMutation.mutate({
        id: botDialog.editingId,
        status: payload.status,
        credentials: payload.credentials,
      });
    }
  }
  function handleUserSubmit(payload: BindingFormSubmit) {
    if (!userDialog || payload.kind !== "user-create") return;
    createMappingMutation.mutate({
      agentId: userDialog.agentId,
      platform: payload.draft.platform,
      externalUserId: payload.draft.externalUserId,
      displayName: payload.draft.displayName,
    });
  }

  const filterAgent = agentFilter ? allAgents.find((a) => a.uuid === agentFilter) : null;

  return (
    <>
      <p className="text-label" style={{ color: "var(--fg-3)", padding: "0 var(--sp-0_5) var(--sp-3)" }}>
        Manage how external platforms (Feishu, Slack, Kael) reach your agents. Bot bindings hold encrypted credentials;
        user bindings map an external user to a human agent in this organization.
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
          <div className="inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <PresenceChip status="online" />
                <span className="text-caption" style={{ color: "var(--fg-3)" }}>
                  {onlineBots}
                </span>
              </span>
              <span className="inline-flex items-center gap-1">
                <PresenceChip status="offline" />
                <span className="text-caption" style={{ color: "var(--fg-3)" }}>
                  {offlineBots}
                </span>
              </span>
            </span>
            <Button size="xs" variant="outline" onClick={() => openCreate("bot")}>
              <Plus className="h-3 w-3" /> Bot binding
            </Button>
          </div>
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
                <DenseTableHead>Connection</DenseTableHead>
                <DenseTableHead>Created</DenseTableHead>
                <DenseTableHead style={{ width: 96, textAlign: "right" }} />
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {adapters.map((a) => {
                const connected = statusByConfigId.get(a.id)?.connected ?? false;
                return (
                  <DenseTableRow key={a.id} interactive onClick={() => navigate(`/agents/${a.agentId}`)}>
                    <DenseTableCell>
                      <span className="mono font-medium">{resolveAgentName(a.agentId)}</span>
                    </DenseTableCell>
                    <DenseTableCell>
                      <DenseBadge>{humanizePlatform(a.platform)}</DenseBadge>
                    </DenseTableCell>
                    <DenseTableCell>
                      <DenseBadge tone={a.status === "active" ? "accent" : "outline"}>
                        {humanizeAdapterStatus(a.status)}
                      </DenseBadge>
                    </DenseTableCell>
                    <DenseTableCell>
                      <PresenceChip status={connected ? "online" : "offline"} />
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
                            initialPlatform: narrowPlatform(a.platform),
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
                );
              })}
            </DenseTableBody>
          </DenseTable>
        )}
      </Section>

      <Section
        title="User bindings"
        count={mappings.length}
        action={
          <Button size="xs" variant="outline" onClick={() => openCreate("user")}>
            <Plus className="h-3 w-3" /> User binding
          </Button>
        }
      >
        {isLoading ? (
          <EmptyRow>Loading…</EmptyRow>
        ) : !mappings.length ? (
          <EmptyRow>{agentFilter ? "No user bindings for this agent yet." : "No user bindings"}</EmptyRow>
        ) : (
          <DenseTable>
            <DenseTableHeader>
              <DenseTableRow>
                <DenseTableHead>Agent</DenseTableHead>
                <DenseTableHead>Platform</DenseTableHead>
                <DenseTableHead>External user ID</DenseTableHead>
                <DenseTableHead>Display name</DenseTableHead>
                <DenseTableHead>Bound via</DenseTableHead>
                <DenseTableHead>Created</DenseTableHead>
                <DenseTableHead style={{ width: 32 }} />
              </DenseTableRow>
            </DenseTableHeader>
            <DenseTableBody>
              {mappings.map((m) => (
                <DenseTableRow key={m.id} interactive onClick={() => navigate(`/agents/${m.agentId}`)}>
                  <DenseTableCell>
                    <span className="mono font-medium" style={{ color: "var(--primary)" }}>
                      {resolveAgentName(m.agentId)}
                    </span>
                  </DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge>{humanizePlatform(m.platform)}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell>
                    <span className="mono text-label" style={{ color: "var(--fg-2)" }}>
                      {m.externalUserId}
                    </span>
                  </DenseTableCell>
                  <DenseTableCell style={{ color: "var(--fg-2)" }}>{m.displayName ?? "—"}</DenseTableCell>
                  <DenseTableCell>
                    <DenseBadge tone="outline">{humanizeBoundVia(m.boundVia)}</DenseBadge>
                  </DenseTableCell>
                  <DenseTableCell className="mono text-caption" style={{ color: "var(--fg-4)" }}>
                    {formatDate(m.createdAt)}
                  </DenseTableCell>
                  <DenseTableCell onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setMappingToDelete(m.id)}
                      disabled={deleteMappingMutation.isPending}
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

      {/* Pick agent → then open the real form. Skipped when ?agent=is set. */}
      <AgentPickerDialog
        open={pickerOpen != null}
        kind={pickerOpen?.kind ?? "bot"}
        agents={allAgents}
        agentId={pickerAgentId}
        onAgentChange={setPickerAgentId}
        onCancel={() => setPickerOpen(null)}
        onConfirm={confirmPicker}
      />

      <BindingFormDialog
        open={botDialog != null}
        kind="bot"
        editingId={botDialog?.editingId ?? null}
        initialPlatform={botDialog?.initialPlatform}
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

      <BindingFormDialog
        open={userDialog != null}
        kind="user"
        editingId={null}
        agentLabel={userDialog ? resolveAgentName(userDialog.agentId) : ""}
        pending={createMappingMutation.isPending}
        errorMessage={createMappingMutation.error instanceof Error ? createMappingMutation.error.message : null}
        onOpenChange={(open) => {
          if (!open) {
            setUserDialog(null);
            createMappingMutation.reset();
          }
        }}
        onSubmit={handleUserSubmit}
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
      <ConfirmDialog
        open={mappingToDelete != null}
        onOpenChange={(o) => !o && setMappingToDelete(null)}
        title="Remove this binding?"
        description="The external user will stop routing to this agent. You can add the mapping again later."
        confirmLabel="Remove binding"
        pending={deleteMappingMutation.isPending}
        onConfirm={() => {
          if (mappingToDelete != null) {
            deleteMappingMutation.mutate(mappingToDelete);
            setMappingToDelete(null);
          }
        }}
      />
    </>
  );
}

// AdapterConfig response type widens platform/status to plain `string` (the
// server response schema uses `z.string()` rather than the enum). We narrow
// here so the form's prop types stay strict; the values are already known to
// match because the server only ever stores valid platform/status strings.
function narrowPlatform(p: string): "feishu" | "slack" | "kael" {
  return p === "feishu" || p === "slack" || p === "kael" ? p : "feishu";
}
function narrowStatus(s: string): "active" | "inactive" {
  return s === "inactive" ? "inactive" : "active";
}

/**
 * Display label for the wire-level platform enum (`feishu` / `slack` /
 * `kael`). Falls back to the raw value so any forward-compat platform the
 * server emits still renders something, just unstyled.
 */
function humanizePlatform(platform: string): string {
  switch (platform) {
    case "feishu":
      return "Feishu";
    case "slack":
      return "Slack";
    case "kael":
      return "Kael";
    default:
      return platform;
  }
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

/**
 * Map the wire-level adapter `bound_via` enum (`code` / `reverse_token` /
 * `oauth` / `manual`) to a sentence-case phrase. Note: this is a DIFFERENT
 * enum from the GitHub-entity `boundVia` used in the chat right sidebar —
 * adapter mappings track how an IM user got bound, not how a PR/issue got
 * linked, so we deliberately do NOT share the helper.
 */
function humanizeBoundVia(boundVia: string | null): string {
  if (!boundVia) return "—";
  switch (boundVia) {
    case "code":
      return "Code";
    case "reverse_token":
      return "Reverse token";
    case "oauth":
      return "OAuth";
    case "manual":
      return "Manual";
    default:
      return boundVia;
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
  kind: "bot" | "user";
  agents: Agent[];
  agentId: string;
  onAgentChange: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Bot bindings are typically attached to autonomous agents; user bindings
  // map external IM users to human agents. Filter the picker accordingly so
  // the operator picks from the right pool.
  const candidates =
    props.kind === "user"
      ? props.agents.filter((a) => a.type === "human" && a.status === "active")
      : props.agents.filter((a) => a.type !== "human" && a.status === "active");

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.kind === "bot" ? "Bind a bot" : "Bind an external user"}</DialogTitle>
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
