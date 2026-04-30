import type { ClientCapabilities, OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { ArrowRight, Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getClientCapabilities, type HubClient, listClients } from "../../../api/activity.js";
import { createAgentChat } from "../../../api/chats.js";
import { api } from "../../../api/client.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Button } from "../../../components/ui/button.js";
import { slugify } from "../../../utils/agent-naming.js";
import {
  clearOnboardingDraft,
  onboardingDraftScope,
  readOnboardingDraft,
  readOnboardingJoinPath,
  writeOnboardingDraft,
} from "../../../utils/onboarding-flags.js";

/**
 * Inline onboarding panel — replaces the previous OnboardingBanner +
 * OnboardingModal pair. Renders directly in CenterPanel when wizardStep is
 * not `completed` and the user hasn't selected a chat. The whole "create your
 * first agent" flow lives here: name input, computer connect, runtime pick,
 * and the post-Create wait state. On runtime-online we navigate to the new
 * chat URL; the chat view handles the empty-chat pre-fill ("Hi {name}!").
 */

const RUNTIME_READY_TIMEOUT_MS = 30_000;
const RUNTIME_READY_POLL_MS = 1_000;
const CLIENT_DETECT_POLL_MS = 3_000;

type Phase = "form" | "creating" | "timeout";

function prettyRuntimeLabel(provider: string): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

export function OnboardingView() {
  const { refreshMe, organizationId, memberId } = useAuth();
  const navigate = useNavigate();
  const draftScope = onboardingDraftScope(organizationId, memberId);
  const initialDraft = readOnboardingDraft(draftScope);
  const initialConnectToken =
    initialDraft?.connectToken && initialDraft.connectTokenExpiresAt && initialDraft.connectTokenExpiresAt > Date.now()
      ? initialDraft.connectToken
      : null;
  const initialConnectTokenExpiresAt = initialConnectToken ? (initialDraft?.connectTokenExpiresAt ?? null) : null;

  const [displayName, setDisplayName] = useState(() => initialDraft?.displayName ?? "");
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(() => initialDraft?.selectedRuntime ?? null);
  const [connectedClient, setConnectedClient] = useState<HubClient | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(() => initialConnectToken);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(() => initialConnectTokenExpiresAt);
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  // Read once on mount — joinPath flips only at sign-in / invite-accept.
  const [joinPath] = useState(() => readOnboardingJoinPath());

  // Persisted across timeout retries so [Try again] does not recreate
  // (and collide on the unique slug).
  const createdAgentRef = useRef<string | null>(null);
  // Cancellation token for the active poll loop. Flipped on unmount so any
  // in-flight `await` boundary returns early without stale state writes.
  const pollCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const capabilitiesClientIdRef = useRef<string | null>(null);
  const detectSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeOnboardingDraft(draftScope, { displayName, selectedRuntime, connectToken, connectTokenExpiresAt });
  }, [draftScope, displayName, selectedRuntime, connectToken, connectTokenExpiresAt]);

  // Greeting source: org displayName for the invite welcome line.
  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort; greeting falls back to generic copy
      }
    })();
  }, []);

  // Detect the user's most recently active connected client + capabilities.
  // Re-fetching capabilities on every tick is the intentional fix for staleness:
  // if the user installs a runtime mid-onboarding, the radio list updates
  // without anything being remounted.
  useEffect(() => {
    if (phase !== "form") return;
    let cancelled = false;
    const detect = async (): Promise<void> => {
      const seq = ++detectSeqRef.current;
      try {
        const clients = await listClients();
        if (cancelled || seq !== detectSeqRef.current) return;
        const connected = clients
          .filter((c) => c.status === "connected")
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        const latest = connected[0] ?? null;
        setConnectedClient((prev) => (prev?.id === latest?.id ? prev : latest));
        if (latest) {
          if (capabilitiesClientIdRef.current !== latest.id) {
            capabilitiesClientIdRef.current = null;
            setCapabilitiesClientId(null);
            setCapabilities(null);
          }
          try {
            const withCaps = await getClientCapabilities(latest.id);
            if (cancelled || seq !== detectSeqRef.current) return;
            capabilitiesClientIdRef.current = latest.id;
            setCapabilitiesClientId(latest.id);
            setCapabilities(withCaps.capabilities);
          } catch {
            // transient — keep last capabilities; next tick retries
          }
        } else {
          capabilitiesClientIdRef.current = null;
          setCapabilitiesClientId(null);
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
  }, [phase]);

  // Lazy-load a connect token when no client is bound yet.
  useEffect(() => {
    if (connectedClient) return;
    if (connectToken && connectTokenExpiresAt && connectTokenExpiresAt > Date.now()) {
      const refreshAt = Math.max(connectTokenExpiresAt - Date.now(), 0);
      const handle = window.setTimeout(() => {
        setConnectToken(null);
        setConnectTokenExpiresAt(null);
      }, refreshAt);
      return () => window.clearTimeout(handle);
    }
    if (connectToken) {
      setConnectToken(null);
      setConnectTokenExpiresAt(null);
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.post<{ token: string; expiresIn: number }>("/connect-tokens", {});
        if (!cancelled) {
          setConnectToken(r.token);
          setConnectTokenExpiresAt(Date.now() + r.expiresIn * 1000);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to generate connect token");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectedClient, connectToken, connectTokenExpiresAt]);

  const activeCapabilities = connectedClient && capabilitiesClientId === connectedClient.id ? capabilities : null;

  // Auto-select the first ok runtime; reset if active selection becomes invalid
  // (client switched, runtime removed). `activeCapabilities` is only non-null
  // when the capabilities payload belongs to the currently selected client.
  useEffect(() => {
    setSelectedRuntime((prev) => {
      if (!activeCapabilities) return prev;
      const ok = Object.entries(activeCapabilities)
        .filter(([, entry]) => entry.state === "ok")
        .map(([provider]) => provider);
      if (prev && ok.includes(prev)) return prev;
      return ok[0] ?? null;
    });
  }, [activeCapabilities]);

  const okRuntimes = activeCapabilities
    ? Object.entries(activeCapabilities)
        .filter(([, entry]) => entry.state === "ok")
        .map(([provider]) => provider)
    : [];

  const teamName = orgs.find((o) => o.id === organizationId)?.displayName ?? "";
  const trimmedName = displayName.trim();
  const nameOrFallback = trimmedName || "your agent";

  const cliCommand = connectToken
    ? `npm install -g @agent-team-foundation/first-tree-hub\nfirst-tree-hub connect ${connectToken}`
    : null;

  const pollUntilReady = useCallback(
    async (agentUuid: string): Promise<void> => {
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
            clearOnboardingDraft(draftScope);
            await refreshMe();
            if (token.cancelled) return;
            navigate(`/?a=${encodeURIComponent(agentUuid)}&c=${encodeURIComponent(chat.id)}`, { replace: true });
          } catch (err) {
            if (token.cancelled) return;
            // Reuse the timeout UI when chat creation fails: the agent +
            // runtime are fine, only the chat creation step failed; [Try
            // again] re-runs pollUntilReady → finds online=true → retries
            // createAgentChat.
            setError(err instanceof Error ? err.message : "Failed to open chat");
            setPhase("timeout");
          }
          return;
        }
        if (Date.now() - startedAt > RUNTIME_READY_TIMEOUT_MS) {
          if (!token.cancelled) setPhase("timeout");
          return;
        }
        await new Promise((r) => setTimeout(r, RUNTIME_READY_POLL_MS));
      }
    },
    [draftScope, refreshMe, navigate],
  );

  const canCreate = !!(
    trimmedName &&
    connectedClient &&
    selectedRuntime &&
    okRuntimes.includes(selectedRuntime) &&
    phase === "form"
  );

  const handleCreate = useCallback(async () => {
    if (!connectedClient || !selectedRuntime || !trimmedName) return;
    setError(null);
    setPhase("creating");
    // Empty slug (e.g. all-CJK input) → omit `name` so the server stores
    // NULL; user can set a handle later in Settings if they need @mention.
    const slug = slugify(trimmedName);
    let agentUuid: string;
    try {
      const res = await api.post<{ uuid: string }>("/admin/agents", {
        type: "personal_assistant",
        displayName: trimmedName,
        ...(slug ? { name: slug } : {}),
        clientId: connectedClient.id,
        runtimeProvider: selectedRuntime,
      });
      agentUuid = res.uuid;
      createdAgentRef.current = agentUuid;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setPhase("form");
      return;
    }
    await pollUntilReady(agentUuid);
  }, [trimmedName, connectedClient, selectedRuntime, pollUntilReady]);

  const handleRetry = useCallback(async () => {
    const agentUuid = createdAgentRef.current;
    if (!agentUuid) return;
    setError(null);
    setPhase("creating");
    await pollUntilReady(agentUuid);
  }, [pollUntilReady]);

  return (
    <div
      className="flex-1 overflow-auto"
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "clamp(var(--sp-16), 12vh, var(--sp-45)) var(--sp-4) var(--sp-12)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 560 }}>
        {phase === "form" && (
          <FormBody
            joinPath={joinPath}
            teamName={teamName}
            displayName={displayName}
            setDisplayName={setDisplayName}
            trimmedName={trimmedName}
            connectedClient={connectedClient}
            cliCommand={cliCommand}
            okRuntimes={okRuntimes}
            selectedRuntime={selectedRuntime}
            setSelectedRuntime={setSelectedRuntime}
            capabilitiesLoaded={activeCapabilities !== null}
            error={error}
            canCreate={canCreate}
            onCreate={handleCreate}
          />
        )}
        {phase === "creating" && <CreatingBody nameOrFallback={nameOrFallback} />}
        {phase === "timeout" && (
          <TimeoutBody
            nameOrFallback={nameOrFallback}
            hostname={connectedClient?.hostname ?? null}
            error={error}
            onRetry={handleRetry}
          />
        )}
      </div>
    </div>
  );
}

function FormBody({
  joinPath,
  teamName,
  displayName,
  setDisplayName,
  trimmedName,
  connectedClient,
  cliCommand,
  okRuntimes,
  selectedRuntime,
  setSelectedRuntime,
  capabilitiesLoaded,
  error,
  canCreate,
  onCreate,
}: {
  joinPath: "solo" | "invite" | null;
  teamName: string;
  displayName: string;
  setDisplayName: (next: string) => void;
  trimmedName: string;
  connectedClient: HubClient | null;
  cliCommand: string | null;
  okRuntimes: string[];
  selectedRuntime: string | null;
  setSelectedRuntime: (next: string) => void;
  capabilitiesLoaded: boolean;
  error: string | null;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const inviteHasTeam = joinPath === "invite" && teamName;
  const introLeadText = inviteHasTeam ? `Welcome — you've joined ${teamName}` : "Welcome to First Tree Hub";
  const nextStepText = !trimmedName
    ? "Next: name your agent."
    : !connectedClient
      ? "Next: connect the computer where they'll work."
      : !selectedRuntime
        ? "Next: choose a runtime."
        : "Ready to create.";

  useEffect(() => {
    if (trimmedName) return;
    nameInputRef.current?.focus();
  }, [trimmedName]);

  return (
    <>
      <div
        className="flex flex-col items-start"
        style={{
          gap: "var(--sp-4)",
          paddingTop: 0,
        }}
      >
        <p className="text-label" style={{ margin: 0, color: "var(--fg-3)", maxWidth: 420 }}>
          <span style={{ color: "var(--fg-2)" }}>{introLeadText}</span>
          <span style={{ color: "var(--fg-4)" }}> · </span>
          Where agents and humans work as one team.
        </p>
        <h1 className="text-title font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
          Let's create your first agent.
        </h1>
      </div>

      <div style={{ marginTop: "var(--sp-5)", position: "relative" }}>
        <StepRailLine />

        <StepFrame number="01" state={trimmedName ? "complete" : "active"}>
          <div className="flex items-baseline" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
            <label
              htmlFor="onboarding-name"
              className="text-body font-normal"
              style={{ color: "var(--fg-2)", whiteSpace: "nowrap" }}
            >
              What should we call this agent?
            </label>
            <input
              ref={nameInputRef}
              id="onboarding-name"
              aria-label="Agent display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Code Reviewer"
              maxLength={200}
              className="onboarding-name-input text-body font-medium"
              style={{
                flex: "0 1 28ch",
                minWidth: "22ch",
                maxWidth: "30ch",
                padding: "var(--sp-0_5) 0",
                background: "transparent",
                border: 0,
                borderBottom: "var(--hairline) solid var(--border-faint)",
                borderRadius: 0,
                boxShadow: "none",
                color: "var(--fg)",
                outline: "none",
                caretColor: "var(--accent)",
                transition: "border-color 160ms ease, color 160ms ease",
              }}
              onFocus={(event) => {
                event.currentTarget.style.borderBottomColor = "var(--accent)";
              }}
              onBlur={(event) => {
                event.currentTarget.style.borderBottomColor = "var(--border-faint)";
              }}
            />
          </div>
        </StepFrame>

        <StepFrame number="02" state={canCreate ? "complete" : trimmedName ? "active" : "idle"}>
          <div style={{ animation: trimmedName ? "subtle-fade 200ms ease-out" : undefined }}>
            <h2
              className="text-subtitle font-semibold"
              style={{
                color: trimmedName ? "var(--fg)" : "var(--fg-4)",
                fontWeight: trimmedName ? 600 : 500,
              }}
            >
              Where will {trimmedName || "this agent"} run?
            </h2>

            {trimmedName ? (
              <>
                <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
                  {connectedClient
                    ? `This computer will run ${trimmedName} and keep it connected to Hub.`
                    : "This agent needs a computer to do its work. Connect the one it should use."}
                </p>
                {!connectedClient && (
                  <p className="text-label" style={{ color: "var(--fg-4)", marginTop: "var(--sp-2)" }}>
                    Open Terminal on that computer and run this command.
                  </p>
                )}

                {connectedClient ? (
                  <ConnectedRow hostname={connectedClient.hostname ?? connectedClient.id} />
                ) : (
                  <>
                    <CommandBox command={cliCommand} />
                    <WaitingRow />
                  </>
                )}

                {connectedClient && (
                  <RuntimeChips
                    runtimes={okRuntimes}
                    selected={selectedRuntime}
                    onSelect={setSelectedRuntime}
                    capabilitiesLoaded={capabilitiesLoaded}
                  />
                )}
              </>
            ) : null}
          </div>
        </StepFrame>
      </div>

      {error && (
        <div
          className="text-body"
          style={{
            marginTop: "var(--sp-4)",
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--state-error)",
          }}
        >
          {error}
        </div>
      )}

      {trimmedName && (
        <div
          style={{
            marginTop: canCreate ? "var(--sp-4)" : "var(--sp-5)",
            marginLeft: "calc(var(--sp-5) + var(--sp-3))",
            animation: "subtle-fade 180ms ease-out",
          }}
        >
          {!canCreate && (
            <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
              {nextStepText}
            </p>
          )}

          {canCreate && (
            <Button
              type="button"
              size="default"
              style={{
                marginTop: 0,
                border: "var(--hairline) solid color-mix(in oklch, var(--accent) 32%, transparent)",
                background: "var(--accent)",
                boxShadow: "var(--shadow-md)",
                color: "var(--primary-foreground, var(--color-primary-foreground))",
                opacity: 1,
                transform: "translateZ(0)",
                transition: "box-shadow 160ms ease, transform 160ms ease",
              }}
              onClick={onCreate}
              onMouseEnter={(event) => {
                event.currentTarget.style.transform = "scale(1.01)";
                event.currentTarget.style.boxShadow = "var(--shadow-md)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.transform = "scale(1)";
                event.currentTarget.style.boxShadow = "var(--shadow-md)";
              }}
            >
              <span>Create {trimmedName}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
          <p
            className="text-caption"
            style={{ margin: canCreate ? "var(--sp-2) 0 0" : "var(--sp-0_5) 0 0", color: "var(--fg-4)" }}
          >
            You can customize this agent after setup.
          </p>
        </div>
      )}
    </>
  );
}

function StepRailLine() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        top: "var(--sp-5)",
        bottom: "var(--sp-5)",
        left: "calc(var(--sp-2_5) - var(--hairline))",
        width: "var(--hairline)",
        background: "color-mix(in oklch, var(--border-faint) 56%, transparent)",
      }}
    />
  );
}

function StepFrame({
  number,
  state,
  children,
}: {
  number: string;
  state: "idle" | "active" | "complete";
  children: ReactNode;
}) {
  const isActive = state === "active";
  const isComplete = state === "complete";

  return (
    <section
      className="grid"
      style={{
        gridTemplateColumns: "var(--sp-5) 1fr",
        columnGap: "var(--sp-3)",
        marginTop: number === "01" ? 0 : "var(--sp-5)",
        position: "relative",
      }}
    >
      <div
        className="mono text-caption flex items-center justify-center"
        style={{
          width: "var(--sp-5)",
          height: "var(--sp-5)",
          borderRadius: 999,
          background: isActive || isComplete ? "color-mix(in oklch, var(--accent) 8%, var(--bg))" : "var(--bg)",
          border:
            isActive || isComplete
              ? "var(--hairline) solid var(--accent)"
              : "var(--hairline) solid var(--border-faint)",
          color: isActive || isComplete ? "var(--accent)" : "var(--fg-4)",
          zIndex: 1,
        }}
      >
        {isComplete ? <Check className="h-3 w-3" /> : number}
      </div>
      <div style={{ minHeight: "var(--sp-6)", paddingBottom: "var(--sp-1)" }}>{children}</div>
    </section>
  );
}

/**
 * Shared command-box visual for Step 2. Shows a readable preview of the
 * connect line while keeping the full install + connect command copy-only.
 */
function CommandBox({ command }: { command: string | null }) {
  const [copied, setCopied] = useState(false);

  const lines = command ? command.split("\n") : [];
  const connectLine = lines.find((l) => l.startsWith("first-tree-hub")) ?? "";
  const connectPrefix = "first-tree-hub connect ";
  const commandPreview = connectLine.startsWith(connectPrefix)
    ? `${connectPrefix}${connectLine.slice(connectPrefix.length, connectPrefix.length + 22)}…`
    : connectLine.length > 52
      ? `${connectLine.slice(0, 52)}…`
      : connectLine;

  const handleCopy = async (): Promise<void> => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ marginTop: "var(--sp-2)" }}>
      <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
        <pre
          className="mono text-label"
          title={connectLine}
          style={{
            flex: 1,
            minHeight: 38,
            margin: 0,
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-2)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          {commandPreview || "Generating token…"}
        </pre>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          disabled={!command}
          style={{
            alignSelf: "stretch",
            background: "color-mix(in oklch, var(--bg-raised) 48%, transparent)",
            borderColor: "color-mix(in oklch, var(--border) 58%, transparent)",
            boxShadow: "none",
            height: "auto",
            minHeight: 38,
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function WaitingRow() {
  return (
    <div
      className="flex items-center text-body"
      style={{
        gap: "var(--sp-2)",
        marginTop: "var(--sp-2_5)",
        color: "color-mix(in oklch, var(--accent) 24%, var(--fg-3))",
      }}
    >
      <PulsingDot />
      <span>Waiting for your computer…</span>
    </div>
  );
}

function ConnectedRow({ hostname }: { hostname: string }) {
  return (
    <div
      className="inline-flex items-center text-body"
      style={{
        gap: "var(--sp-2)",
        marginTop: "var(--sp-2_5)",
        padding: "var(--sp-1_5) var(--sp-2_5)",
        borderRadius: 999,
        background: "color-mix(in oklch, var(--accent) 10%, transparent)",
        color: "color-mix(in oklch, var(--accent) 26%, var(--fg))",
        animation: "onboarding-pop 260ms cubic-bezier(0.2, 0.9, 0.2, 1.15)",
      }}
    >
      <Check className="h-3.5 w-3.5" />
      <span>
        <span className="mono font-semibold">{hostname}</span> connected
      </span>
    </div>
  );
}

function RuntimeChips({
  runtimes,
  selected,
  onSelect,
  capabilitiesLoaded,
}: {
  runtimes: string[];
  selected: string | null;
  onSelect: (next: string) => void;
  capabilitiesLoaded: boolean;
}) {
  if (runtimes.length === 0) {
    return (
      <p className="text-label" style={{ marginTop: "var(--sp-3)", color: "var(--fg-3)" }}>
        {capabilitiesLoaded
          ? "No runtime ready on this computer. Install Claude Code or Codex, then check back."
          : "Detecting installed runtimes…"}
      </p>
    );
  }
  return (
    <div style={{ marginTop: "var(--sp-3)" }}>
      <p className="text-label" style={{ color: "var(--fg-3)", marginBottom: "var(--sp-1)" }}>
        Powered by
      </p>
      <fieldset className="flex" style={{ gap: "var(--sp-4)", flexWrap: "wrap", margin: 0, padding: 0, border: 0 }}>
        <legend className="sr-only">Runtime provider</legend>
        {runtimes.map((provider, index) => {
          const active = selected === provider;
          return (
            <label
              key={provider}
              className="onboarding-runtime-option inline-flex items-center text-body"
              style={{
                gap: "var(--sp-1_5)",
                padding: "var(--sp-1) 0",
                cursor: "pointer",
                color: active ? "color-mix(in oklch, var(--accent) 30%, var(--fg))" : "var(--fg)",
                fontWeight: active ? 600 : 400,
                animation: `onboarding-rise 220ms ease-out ${index * 80}ms both`,
                transition: "color 160ms ease, opacity 160ms ease, transform 160ms ease",
              }}
            >
              <input
                type="radio"
                name="onboarding-runtime"
                value={provider}
                checked={active}
                onChange={() => onSelect(provider)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className="inline-flex items-center justify-center"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-strong)",
                  background: active ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent",
                  boxShadow: active
                    ? "0 0 0 var(--sp-0_5) color-mix(in oklch, var(--accent) 10%, transparent)"
                    : "none",
                  transition: "border-color 160ms ease, background 160ms ease, box-shadow 160ms ease",
                }}
              >
                {active && (
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--accent)",
                    }}
                  />
                )}
              </span>
              {prettyRuntimeLabel(provider)}
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}

function PulsingDot() {
  return (
    <span
      aria-hidden="true"
      style={{ position: "relative", display: "inline-block", width: 8, height: 8, flexShrink: 0 }}
    >
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "var(--accent)" }} />
      <span
        style={{
          position: "absolute",
          inset: -3,
          borderRadius: "50%",
          border: "var(--hairline) solid var(--accent)",
          animation: "ring-pulse 1.8s infinite",
          opacity: 0.55,
        }}
      />
    </span>
  );
}

function CreatingBody({ nameOrFallback }: { nameOrFallback: string }) {
  return (
    <div className="flex flex-col items-center text-center" style={{ paddingTop: "var(--sp-12)", gap: "var(--sp-4)" }}>
      <p className="text-title" style={{ color: "var(--fg)" }}>
        Creating {nameOrFallback}…
      </p>
      <BouncingDots />
      <p className="text-body" style={{ color: "var(--fg-3)" }}>
        Usually takes ~10 seconds
      </p>
    </div>
  );
}

function TimeoutBody({
  nameOrFallback,
  hostname,
  error,
  onRetry,
}: {
  nameOrFallback: string;
  hostname: string | null;
  error: string | null;
  onRetry: () => void;
}) {
  const computerLabel = hostname ?? "your computer";
  return (
    <div className="flex flex-col" style={{ paddingTop: "var(--sp-8)", gap: "var(--sp-4)" }}>
      <p className="text-title" style={{ color: "var(--fg)" }}>
        {nameOrFallback} is taking longer than expected.
      </p>

      {error ? (
        <div
          className="text-body"
          style={{
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--state-error) 10%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 25%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--state-error)",
          }}
        >
          {error}
        </div>
      ) : (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <p>This usually means:</p>
          <ul style={{ paddingLeft: "var(--sp-4)", listStyle: "disc", marginTop: "var(--sp-1_5)" }}>
            <li>The runtime can't start on {computerLabel} (missing API key, etc.)</li>
            <li>The connection to {computerLabel} dropped</li>
          </ul>
          <p style={{ marginTop: "var(--sp-2)" }}>
            Fix it on {computerLabel}, then click <span className="font-semibold">Try again</span>.
          </p>
        </div>
      )}

      <div className="flex" style={{ gap: "var(--sp-2)" }}>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </div>
  );
}

function BouncingDots() {
  return (
    <span className="flex items-center" style={{ gap: 6 }}>
      <Dot delayMs={0} />
      <Dot delayMs={160} />
      <Dot delayMs={320} />
    </span>
  );
}

function Dot({ delayMs }: { delayMs: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: "var(--accent)",
        animation: "heartbeat-pulse 1.2s ease-in-out infinite",
        animationDelay: `${delayMs}ms`,
        display: "inline-block",
      }}
    />
  );
}
