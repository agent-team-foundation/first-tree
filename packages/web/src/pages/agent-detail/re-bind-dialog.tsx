import {
  type Agent,
  type CapabilityEntry,
  type ClientCapabilities,
  RUNTIME_PROVIDERS,
  type RuntimeProvider,
} from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type HubClient, listClients } from "../../api/activity.js";
import { rebindAgent } from "../../api/agents.js";
import { ApiError } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";

const PROVIDER_LABEL: Record<RuntimeProvider, string> = {
  "claude-code": "Claude Code",
  "claude-code-tui": "Claude Code (TUI)",
  codex: "Codex",
};

const PROVIDER_ORDER: RuntimeProvider[] = [
  RUNTIME_PROVIDERS.CLAUDE_CODE,
  RUNTIME_PROVIDERS.CLAUDE_CODE_TUI,
  RUNTIME_PROVIDERS.CODEX,
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
};

/**
 * Unified Re-bind dialog (UX U2): switching computer or runtime provider —
 * or both at once — flow through this component. The single dialog keeps a
 * consistent confirm + warning model regardless of whether the operator
 * changes the bound client, the runtime provider, or both.
 */
export function ReBindDialog({ open, onOpenChange, agent }: Props) {
  const queryClient = useQueryClient();
  const currentClientId = agent.clientId;
  const currentProvider = agent.runtimeProvider;

  const [selectedClientId, setSelectedClientId] = useState<string | null>(currentClientId);
  const [selectedProvider, setSelectedProvider] = useState<RuntimeProvider>(currentProvider);
  const [force, setForce] = useState(false);

  const clientsQuery = useQuery({
    queryKey: ["clients-rebind"],
    queryFn: listClients,
    enabled: open,
  });

  const candidateClients = clientsQuery.data ?? [];

  // Capability snapshots ride along on every list row now (`/me/clients`
  // includes the `metadata.capabilities` blob), so the runtime picker
  // greys-out missing providers without fanning out N `GET /clients/:id`
  // requests when the dialog opens. The data freshness is bounded by the
  // list refetch cadence (5s while the dialog is mounted via react-query),
  // which is plenty for the "is Codex installed on machine X" question.
  const capabilitiesByClient = useMemo(() => {
    const map = new Map<string, ClientCapabilities>();
    for (const c of candidateClients) map.set(c.id, c.capabilities);
    return map;
  }, [candidateClients]);

  useEffect(() => {
    if (!open) {
      setSelectedClientId(currentClientId);
      setSelectedProvider(currentProvider);
      setForce(false);
    }
  }, [open, currentClientId, currentProvider]);

  const selectedCapabilities: ClientCapabilities | null = selectedClientId
    ? (capabilitiesByClient.get(selectedClientId) ?? null)
    : null;

  const providerEntry: CapabilityEntry | null = selectedCapabilities?.[selectedProvider] ?? null;
  const capabilityMissing = !providerEntry || providerEntry.state === "missing" || providerEntry.state === "error";
  const canSubmit =
    !!selectedClientId &&
    (selectedClientId !== currentClientId || selectedProvider !== currentProvider) &&
    (!capabilityMissing || force);

  const providerChanged = selectedProvider !== currentProvider;
  const clientChanged = selectedClientId !== currentClientId;

  const rebindMut = useMutation({
    mutationFn: () => {
      if (!selectedClientId) throw new Error("clientId required");
      return rebindAgent(agent.uuid, {
        clientId: selectedClientId,
        runtimeProvider: selectedProvider,
        force: capabilityMissing && force ? true : undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", agent.uuid] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      onOpenChange(false);
    },
  });

  const errorMessage =
    rebindMut.error instanceof ApiError
      ? rebindMut.error.message
      : rebindMut.error instanceof Error
        ? rebindMut.error.message
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Re-bind agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-caption" style={{ color: "var(--fg-3)" }}>
            Currently:{" "}
            <span className="mono">{describeCurrent(currentClientId, candidateClients, currentProvider)}</span>
          </p>

          <div className="space-y-2">
            <Label>Computer</Label>
            <select
              value={selectedClientId ?? ""}
              onChange={(e) => setSelectedClientId(e.target.value || null)}
              className="w-full rounded-[var(--radius-input)] border border-input bg-background px-3 py-2 text-body"
            >
              {candidateClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {clientLabel(c)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label>Runtime</Label>
            <div className="space-y-2">
              {PROVIDER_ORDER.map((provider) => {
                const entry = selectedCapabilities?.[provider] ?? null;
                const enabled = !!entry && entry.state !== "missing";
                const checked = selectedProvider === provider;
                return (
                  <label
                    key={provider}
                    className={
                      checked
                        ? "flex items-start gap-3 rounded-md border border-primary bg-primary/5 p-3 cursor-pointer"
                        : enabled
                          ? "flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
                          : "flex items-start gap-3 rounded-md border border-border p-3 opacity-60"
                    }
                  >
                    <input
                      type="radio"
                      name="rebind-runtime"
                      checked={checked}
                      onChange={() => setSelectedProvider(provider)}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-body font-medium">{PROVIDER_LABEL[provider]}</div>
                      <div className="text-caption" style={{ color: "var(--fg-3)" }}>
                        {capabilityCaption(entry, provider)}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {(clientChanged || providerChanged) && (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-caption space-y-1">
              <p>
                <span className="font-medium">Heads up:</span> active sessions on the previous computer are suspended at
                re-bind. Chat history is preserved.
              </p>
              {providerChanged && (
                <p>
                  Some configuration fields don't transfer between providers (e.g. claude permission_mode is dropped;
                  codex sandboxMode resets to default).
                </p>
              )}
            </div>
          )}

          {capabilityMissing && (
            <label className="flex items-start gap-2 text-caption" style={{ color: "var(--fg-2)" }}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="mt-0.5" />
              <span>
                Override capability check — pick this if the destination computer is offline or the SDK was just
                installed and capabilities haven't refreshed yet.
              </span>
            </label>
          )}

          {errorMessage && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-body text-destructive">
              {errorMessage}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={rebindMut.isPending}>
            Cancel
          </Button>
          <Button onClick={() => rebindMut.mutate()} disabled={!canSubmit || rebindMut.isPending}>
            {rebindMut.isPending ? "Re-binding…" : "Re-bind"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function clientLabel(c: HubClient): string {
  const head = c.hostname ?? c.id;
  return `${head} · ${c.status}`;
}

function describeCurrent(currentClientId: string | null, clients: HubClient[], provider: RuntimeProvider): string {
  const c = currentClientId ? clients.find((row) => row.id === currentClientId) : null;
  const clientName = c?.hostname ?? currentClientId ?? "(unbound)";
  return `${clientName} · ${PROVIDER_LABEL[provider]}`;
}

const UNAUTH_HINT: Record<RuntimeProvider, string> = {
  "claude-code": "Run `claude login` (or set ANTHROPIC_API_KEY) on the computer.",
  "claude-code-tui": "Run `claude login` (or set ANTHROPIC_API_KEY) on the computer. Also requires tmux ≥ 3.0.",
  codex: "Run `codex login` (or set CODEX_API_KEY) on the computer.",
};

function capabilityCaption(entry: CapabilityEntry | null, provider: RuntimeProvider): string {
  if (!entry) return "Not reported on this computer.";
  switch (entry.state) {
    case "ok":
      return `Installed${entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}, authenticated.`;
    case "unauthenticated":
      return `Installed${entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}, not authenticated. ${UNAUTH_HINT[provider]}`;
    case "missing":
      return "SDK not installed on this computer.";
    case "error":
      return entry.error ? `Probe error: ${entry.error}` : "Probe error.";
  }
}
