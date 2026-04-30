import type { ClientCapabilities, OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getClientCapabilities, type HubClient, listClients } from "../api/activity.js";
import { createAgentChat } from "../api/chats.js";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { useOnboardingState } from "../hooks/use-onboarding-state.js";
import { slugify } from "../utils/agent-naming.js";
import { ConnectCommandPanel } from "./connect-command-panel.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

/**
 * Single-card onboarding: name + connect + runtime + Create button, all
 * visible at once. "Create" succeeds only when the agent's runtime actually
 * comes online on the bound client (poll `/admin/agents/:uuid/client-status`
 * until `online`), so the user lands on a chat where the agent can already
 * answer.
 */

const RUNTIME_READY_TIMEOUT_MS = 30_000;
const RUNTIME_READY_POLL_MS = 1_000;
const CLIENT_DETECT_POLL_MS = 3_000;
const RUNTIME_READY_TIMEOUT_S = RUNTIME_READY_TIMEOUT_MS / 1000;

type CreatingPhase = "creating-agent" | "starting-runtime" | "timeout" | null;

/** Polished label for known runtime providers; falls back to the raw id. */
function prettyRuntimeLabel(provider: string): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

export function OnboardingModal() {
  const { modalOpen, closeModal, joinPath } = useOnboardingState();
  const { refreshMe, organizationId } = useAuth();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(null);
  const [connectedClient, setConnectedClient] = useState<HubClient | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [creatingPhase, setCreatingPhase] = useState<CreatingPhase>(null);
  const [error, setError] = useState<string | null>(null);

  // Persisted across timeout retries so Try again does not recreate (and
  // collide on the unique name).
  const createdAgentRef = useRef<string | null>(null);
  // Cancellation token for the active poll loop. Flipping `cancelled` makes
  // every awaited step in pollUntilReady return early, so closing the modal
  // mid-poll does not race state updates or fire a stale navigate().
  const pollCancelRef = useRef<{ cancelled: boolean } | null>(null);

  // Reset on open. wizardStep may already be "create_agent" (returning user
  // with a connected client) — the card just renders Section 2 as already
  // satisfied in that case. On close, cancel the active poll loop.
  useEffect(() => {
    if (!modalOpen) {
      if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
      return;
    }
    setDisplayName("");
    setSelectedRuntime(null);
    setConnectedClient(null);
    setCapabilities(null);
    setConnectToken(null);
    setCreatingPhase(null);
    setError(null);
    createdAgentRef.current = null;
    pollCancelRef.current = null;
  }, [modalOpen]);

  // Greeting source: org name (only used in invite path).
  useEffect(() => {
    if (!modalOpen) return;
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort; greeting falls back to generic copy
      }
    })();
  }, [modalOpen]);

  // Detect the user's most recently active connected client + its runtime
  // capabilities. Polls every 3s while the modal is open and the user hasn't
  // started creating yet. Re-fetching capabilities on every tick is the
  // intentional fix for capability staleness — if the user installs a runtime
  // mid-onboarding, the radio list updates without a modal reopen.
  useEffect(() => {
    if (!modalOpen || creatingPhase) return;
    let cancelled = false;
    const detect = async (): Promise<void> => {
      try {
        const clients = await listClients();
        if (cancelled) return;
        const connected = clients
          .filter((c) => c.status === "connected")
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        const latest = connected[0] ?? null;
        setConnectedClient((prev) => (prev?.id === latest?.id ? prev : latest));
        if (latest) {
          try {
            const withCaps = await getClientCapabilities(latest.id);
            if (cancelled) return;
            setCapabilities(withCaps.capabilities);
          } catch {
            // transient — keep last capabilities; next tick retries
          }
        } else {
          setCapabilities(null);
        }
      } catch {
        // best-effort
      }
    };
    void detect();
    const handle = setInterval(detect, CLIENT_DETECT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [modalOpen, creatingPhase]);

  // Lazy-load a connect token when no client is bound yet.
  useEffect(() => {
    if (!modalOpen || connectedClient || connectToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.post<{ token: string; expiresIn: number }>("/connect-tokens", {});
        if (!cancelled) setConnectToken(r.token);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to generate connect token");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modalOpen, connectedClient, connectToken]);

  // Compute the runtime options visible to the user (only state="ok" — the
  // ones we can actually pin without sending the user to fix auth/install).
  // Default-select the first one. If the active selection becomes invalid
  // (client switched, runtime removed), drop back to the first ok option.
  const okRuntimes = capabilities
    ? Object.entries(capabilities)
        .filter(([, entry]) => entry.state === "ok")
        .map(([provider]) => provider)
    : [];
  // Functional setter avoids reading `selectedRuntime` from closure, so the
  // dependency list legitimately stays at [capabilities] without lint suppression.
  useEffect(() => {
    setSelectedRuntime((prev) => {
      if (!capabilities) return null;
      const ok = Object.entries(capabilities)
        .filter(([, entry]) => entry.state === "ok")
        .map(([provider]) => provider);
      if (prev && ok.includes(prev)) return prev;
      return ok[0] ?? null;
    });
  }, [capabilities]);

  const teamName = orgs.find((o) => o.id === organizationId)?.displayName ?? "";
  const greeting = joinPath === "invite" && teamName ? `You've joined ${teamName}.` : "Set up your first agent";

  const cliCommand = connectToken
    ? `npm install -g @agent-team-foundation/first-tree-hub\nfirst-tree-hub connect ${connectToken}`
    : null;

  // Poll `/admin/agents/:uuid/client-status` until `online: true` or the
  // 30s timeout. Cancellable via `pollCancelRef`: on modal close every
  // awaited boundary returns early without touching state.
  const pollUntilReady = useCallback(
    async (agentUuid: string): Promise<void> => {
      // Cancel any prior loop so two retries can't coexist.
      if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
      const token: { cancelled: boolean } = { cancelled: false };
      pollCancelRef.current = token;

      const startedAt = Date.now();
      while (!token.cancelled) {
        let online = false;
        try {
          const status = await api.get<{ online: boolean; clientId: string | null }>(
            `/admin/agents/${encodeURIComponent(agentUuid)}/client-status`,
          );
          if (token.cancelled) return;
          online = status.online === true;
        } catch {
          if (token.cancelled) return;
          // transient — keep polling
        }
        if (online) {
          try {
            const chat = await createAgentChat(agentUuid);
            if (token.cancelled) return;
            await refreshMe();
            if (token.cancelled) return;
            closeModal();
            navigate(`/?a=${encodeURIComponent(agentUuid)}&c=${encodeURIComponent(chat.id)}`, { replace: true });
          } catch (err) {
            if (token.cancelled) return;
            // Reuse the timeout UI: agent + runtime are fine, only the chat
            // creation failed. "Try again" will re-enter the loop, find
            // online=true again, and retry createAgentChat.
            setError(err instanceof Error ? err.message : "Failed to open chat");
            setCreatingPhase("timeout");
          }
          return;
        }
        if (Date.now() - startedAt > RUNTIME_READY_TIMEOUT_MS) {
          if (!token.cancelled) setCreatingPhase("timeout");
          return;
        }
        await new Promise((r) => setTimeout(r, RUNTIME_READY_POLL_MS));
      }
    },
    [refreshMe, closeModal, navigate],
  );

  const canCreate = !!(
    displayName.trim() &&
    connectedClient &&
    selectedRuntime &&
    okRuntimes.includes(selectedRuntime) &&
    !creatingPhase
  );

  const handleCreate = useCallback(async () => {
    const trimmed = displayName.trim();
    if (!connectedClient || !selectedRuntime || !trimmed) return;
    setError(null);
    setCreatingPhase("creating-agent");
    // Derive the @handle slug from the display name. Empty (e.g. all CJK)
    // → omit `name` so the server stores NULL; the user can set a handle
    // later in Settings if they need one for @mention.
    const slug = slugify(trimmed);
    let agentUuid: string;
    try {
      const res = await api.post<{ uuid: string }>("/admin/agents", {
        type: "personal_assistant",
        displayName: trimmed,
        ...(slug ? { name: slug } : {}),
        clientId: connectedClient.id,
        runtimeProvider: selectedRuntime,
      });
      agentUuid = res.uuid;
      createdAgentRef.current = agentUuid;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setCreatingPhase(null);
      return;
    }
    setCreatingPhase("starting-runtime");
    await pollUntilReady(agentUuid);
  }, [displayName, connectedClient, selectedRuntime, pollUntilReady]);

  const handleRetry = useCallback(async () => {
    const agentUuid = createdAgentRef.current;
    if (!agentUuid) return;
    setError(null);
    setCreatingPhase("starting-runtime");
    await pollUntilReady(agentUuid);
  }, [pollUntilReady]);

  // Block dismissal only while a network call is in flight; allow dismissal
  // during the timeout state (the user explicitly wants out).
  const dismissBlocked = creatingPhase === "creating-agent" || creatingPhase === "starting-runtime";

  return (
    <Dialog open={modalOpen} onOpenChange={(next) => !next && !dismissBlocked && closeModal()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{greeting}</DialogTitle>
          <DialogDescription>Three quick steps and you're chatting with your agent.</DialogDescription>
        </DialogHeader>

        {/* Top-level error banner. Hidden in the timeout phase so the
            phase-specific timeout block can frame the error in context
            (runtime timeout vs createAgentChat failure). */}
        {error && creatingPhase !== "timeout" && (
          <div className="rounded-md bg-destructive/10 p-2 text-label text-destructive">{error}</div>
        )}

        <div className="space-y-2">
          <Label htmlFor="onboarding-agent-name">
            <span className="font-semibold">1. Agent name</span>
          </Label>
          <Input
            id="onboarding-agent-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My assistant"
            maxLength={200}
            autoFocus
            disabled={!!creatingPhase}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold">2. Connect a computer</span>
            {connectedClient && (
              <span className="text-label" style={{ color: "var(--color-success)" }}>
                ✓ Connected
              </span>
            )}
          </div>
          {connectedClient ? (
            <p className="text-label text-muted-foreground">{connectedClient.id}</p>
          ) : (
            <ConnectCommandPanel
              command={cliCommand}
              phase="waiting"
              copyLabel={{ idle: "Copy commands", done: "Copied" }}
              waitingText="Waiting for your computer to check in…"
              caption={null}
              copyButtonPlacement="bottom"
            />
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2" id="onboarding-runtime-label">
            <span className="font-semibold">3. Where it runs</span>
            {!connectedClient && <span className="text-label text-muted-foreground">(available after connecting)</span>}
          </div>
          {connectedClient && okRuntimes.length === 0 && (
            <p className="text-label text-destructive">
              No runtime is ready on this computer. Install Claude Code or Codex, then check back.
            </p>
          )}
          {okRuntimes.length > 0 && (
            <div role="radiogroup" aria-labelledby="onboarding-runtime-label" className="space-y-1">
              {okRuntimes.map((provider) => (
                <label key={provider} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="onboarding-runtime"
                    value={provider}
                    checked={selectedRuntime === provider}
                    onChange={() => setSelectedRuntime(provider)}
                    disabled={!!creatingPhase}
                  />
                  <span>{prettyRuntimeLabel(provider)}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {creatingPhase === "creating-agent" && <p className="text-body text-muted-foreground">⟳ Creating agent…</p>}
        {creatingPhase === "starting-runtime" && (
          <div className="space-y-1">
            <p className="text-body text-muted-foreground">✓ Agent created</p>
            <p className="text-body text-muted-foreground">⟳ Starting runtime on your computer…</p>
          </div>
        )}
        {creatingPhase === "timeout" && (
          <div className="space-y-2">
            {error ? (
              <>
                <p className="text-body text-destructive">⚠️ {error}</p>
                <p className="text-label text-muted-foreground">
                  Your agent is set up but we couldn't open the chat. Click Try again, or Close to abandon this attempt
                  — reusing the same name will require deleting the existing agent in Settings first.
                </p>
              </>
            ) : (
              <>
                <p className="text-body text-destructive">
                  ⚠️ The runtime didn't start within {RUNTIME_READY_TIMEOUT_S} seconds.
                </p>
                <p className="text-label text-muted-foreground">
                  Common causes: missing API key, network issue, expired credentials. Your agent has been created — fix
                  the issue on your computer and click Try again. If you close instead, reusing the same name will
                  require deleting the existing agent in Settings first.
                </p>
              </>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleRetry}>
                Try again
              </Button>
              <Button variant="outline" onClick={closeModal}>
                Close
              </Button>
            </div>
          </div>
        )}
        {!creatingPhase && (
          <Button className="w-full" disabled={!canCreate} onClick={handleCreate}>
            Create
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
