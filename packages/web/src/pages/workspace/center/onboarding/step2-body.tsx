import type { AgentVisibility, ClientCapabilities, OrgBrief } from "@first-tree/shared";
import { ArrowRight, Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getClientCapabilities, type HubClient, listClients } from "../../../../api/activity.js";
import { api, withOrg } from "../../../../api/client.js";
import { reportOnboardingEvent } from "../../../../api/onboarding-events.js";
import { useAuth } from "../../../../auth/auth-context.js";
import { Button } from "../../../../components/ui/button.js";
import { slugify } from "../../../../utils/agent-naming.js";
import {
  clearOnboardingDraft,
  onboardingDraftScope,
  readOnboardingDraft,
  writeOnboardingAgentUuid,
  writeOnboardingDraft,
} from "../../../../utils/onboarding-flags.js";
import { StepFrame, StepRailLine } from "./step-frame.js";

const RUNTIME_READY_TIMEOUT_MS = 30_000;
const RUNTIME_READY_POLL_MS = 1_000;
const CLIENT_DETECT_POLL_MS = 3_000;

type Phase = "form" | "creating" | "timeout";

function prettyRuntimeLabel(provider: string): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

export function Step2Body({
  organizationId,
  memberId,
  orgHasOtherMembers,
  refreshMe,
}: {
  organizationId: string | null;
  memberId: string | null;
  /**
   * `true` when the caller's org has at least one ACTIVE member besides
   * themselves. Drives the "You've joined {team}…" team-aware headline
   * copy. Sourced from `/me` (per-membership count) so it stays accurate
   * across tabs/devices — the prior `joinPath === "invite"` proxy could
   * desync from server reality when sessionStorage was cleared.
   */
  orgHasOtherMembers: boolean;
  refreshMe: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const draftScope = onboardingDraftScope(organizationId, memberId);
  const initialDraft = readOnboardingDraft(draftScope);
  const initialConnectToken =
    initialDraft?.connectToken && initialDraft.connectTokenExpiresAt && initialDraft.connectTokenExpiresAt > Date.now()
      ? initialDraft.connectToken
      : null;
  const initialConnectTokenExpiresAt = initialConnectToken ? (initialDraft?.connectTokenExpiresAt ?? null) : null;

  // Default agent name: `${login}'s assistant` — mirrors the `${login}'s team`
  // idiom already used at OAuth bootstrap (see auth/github.ts). Personalizing
  // by login avoids "Assistant" colliding across teammates and keeps the
  // first agent's name visibly tied to its owner. Falls back to "Assistant"
  // for the edge case where /me hasn't loaded yet. The draft override wins
  // so we don't clobber a name a returning user already typed.
  const [displayName, setDisplayName] = useState(
    () => initialDraft?.displayName ?? (user?.username ? `${user.username}'s assistant` : "Assistant"),
  );
  // Default visibility: "organization" (Shared with team). Aligns with the
  // product's agent-team collaboration framing — a teammate's onboarding
  // agent should be reachable by the rest of the org by default. The
  // standalone NewAgentDialog keeps its own "private" default (different
  // product decision: dialog is also used by power users creating personal
  // throwaways), so we do NOT touch that surface.
  const [visibility, setVisibility] = useState<AgentVisibility>(() => initialDraft?.visibility ?? "organization");
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(() => initialDraft?.selectedRuntime ?? null);
  const [connectedClient, setConnectedClient] = useState<HubClient | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(() => initialConnectToken);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(() => initialConnectTokenExpiresAt);
  // Server-built bootstrap command (npm install + login) with channel-aware
  // npm spec. Replaces the client-side hardcoded `@latest` so staging users
  // (channel=alpha) install the right package on first run instead of
  // landing on stable and watching auto-update yank them forward.
  const [bootstrapCommand, setBootstrapCommand] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);

  const createdAgentRef = useRef<string | null>(null);
  const pollCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const capabilitiesClientIdRef = useRef<string | null>(null);
  const detectSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeOnboardingDraft(draftScope, {
      displayName,
      selectedRuntime,
      connectToken,
      connectTokenExpiresAt,
      visibility,
    });
  }, [draftScope, displayName, selectedRuntime, connectToken, connectTokenExpiresAt, visibility]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort
      }
    })();
  }, []);

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
            // transient
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
        const r = await api.post<{ token: string; expiresIn: number; bootstrapCommand: string }>(
          "/me/connect-tokens",
          {},
        );
        if (!cancelled) {
          setConnectToken(r.token);
          setConnectTokenExpiresAt(Date.now() + r.expiresIn * 1000);
          setBootstrapCommand(r.bootstrapCommand);
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

  // Auto-pick the first ok runtime per §6.5 (claude-code preferred). No
  // runtime UI in onboarding; multi-runtime picker lives in NewAgentDialog.
  useEffect(() => {
    setSelectedRuntime((prev) => {
      if (!activeCapabilities) return prev;
      const ok = pickPreferredRuntime(activeCapabilities);
      if (prev && ok && Object.keys(activeCapabilities).includes(prev) && activeCapabilities[prev]?.state === "ok") {
        return prev;
      }
      return ok;
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

  // Prefer the server-built command (channel-aware npm spec); fall back to
  // a client-side construction only if the bootstrap field is missing —
  // e.g. an old server, or a transient race where `connectToken` arrives
  // but `bootstrapCommand` hasn't landed in state yet.
  const cliCommand =
    bootstrapCommand ?? (connectToken ? `npm install -g first-tree\nfirst-tree login ${connectToken}` : null);

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
            `/agents/${encodeURIComponent(agentUuid)}/client-status`,
          );
          if (token.cancelled) return;
          online = status.online === true;
        } catch {
          if (token.cancelled) return;
        }
        if (online) {
          // End of Step 2: agent + computer are wired up. Hand off to Step 3
          // by clearing the draft, refreshing /me (so onboardingStep flips
          // to "completed"), and landing on `/`. CenterPanel routes to
          // OnboardingView → Step3IntroBody, where the user opts in to the
          // tree-init chat. See docs/new-user-onboarding-design.md §6.6.
          clearOnboardingDraft(draftScope);
          try {
            await refreshMe();
          } catch {
            // best-effort — the next /me refresh will catch up
          }
          if (token.cancelled) return;
          navigate("/", { replace: true });
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
    const slug = slugify(trimmedName);
    let agentUuid: string;
    try {
      // Step 2 creates an unbound agent — `gitRepos` stays empty until
      // Step 3 picks the source repo. The agent is fully functional in
      // this state for general (non-code) chat; code-context binding is
      // a Step 3 concern. See docs/new-user-onboarding-design.md §6/§7.
      const res = await api.post<{ uuid: string }>(withOrg("/agents"), {
        type: "personal_assistant",
        displayName: trimmedName,
        ...(slug ? { name: slug } : {}),
        clientId: connectedClient.id,
        runtimeProvider: selectedRuntime,
        // Explicit pass — the server's `defaultVisibility(personal_assistant)`
        // returns "private" (kept that way intentionally), but onboarding
        // defaults to "organization" (the agent-team framing). Sending the
        // chosen value avoids any reliance on server defaults that would
        // diverge from the radio's visible selection.
        visibility,
        ...(organizationId ? { organizationId } : {}),
      });
      agentUuid = res.uuid;
      createdAgentRef.current = agentUuid;
      // Stash for Step 3 — uuidv7 sort would also work, but an explicit
      // "the user just created THIS agent" hint avoids picking the wrong
      // agent if the user has more than one managed agent on a re-visit.
      writeOnboardingAgentUuid(agentUuid);
      void reportOnboardingEvent("agent_created", {
        runtimeProvider: selectedRuntime,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setPhase("form");
      return;
    }

    await pollUntilReady(agentUuid);
  }, [trimmedName, connectedClient, selectedRuntime, visibility, pollUntilReady, organizationId]);

  const handleRetry = useCallback(async () => {
    const agentUuid = createdAgentRef.current;
    if (!agentUuid) return;
    setError(null);
    setPhase("creating");
    await pollUntilReady(agentUuid);
  }, [pollUntilReady]);

  if (phase === "creating") {
    return <CreatingBody nameOrFallback={nameOrFallback} />;
  }
  if (phase === "timeout") {
    return (
      <TimeoutBody
        nameOrFallback={nameOrFallback}
        hostname={connectedClient?.hostname ?? null}
        error={error}
        onRetry={handleRetry}
      />
    );
  }

  return (
    <Step2FormBody
      orgHasOtherMembers={orgHasOtherMembers}
      teamName={teamName}
      displayName={displayName}
      setDisplayName={setDisplayName}
      trimmedName={trimmedName}
      connectedClient={connectedClient}
      cliCommand={cliCommand}
      capabilitiesLoaded={activeCapabilities !== null}
      okRuntimes={okRuntimes}
      selectedRuntime={selectedRuntime}
      setSelectedRuntime={setSelectedRuntime}
      visibility={visibility}
      setVisibility={setVisibility}
      error={error}
      canCreate={canCreate}
      onCreate={handleCreate}
    />
  );
}

function pickPreferredRuntime(caps: ClientCapabilities): string | null {
  const ok = (provider: string) => caps[provider]?.state === "ok";
  if (ok("claude-code")) return "claude-code";
  if (ok("codex")) return "codex";
  const first = Object.entries(caps).find(([, entry]) => entry.state === "ok");
  return first ? first[0] : null;
}

function Step2FormBody({
  orgHasOtherMembers,
  teamName,
  displayName,
  setDisplayName,
  trimmedName,
  connectedClient,
  cliCommand,
  capabilitiesLoaded,
  okRuntimes,
  selectedRuntime,
  setSelectedRuntime,
  visibility,
  setVisibility,
  error,
  canCreate,
  onCreate,
}: {
  orgHasOtherMembers: boolean;
  teamName: string;
  displayName: string;
  setDisplayName: (next: string) => void;
  trimmedName: string;
  connectedClient: HubClient | null;
  cliCommand: string | null;
  capabilitiesLoaded: boolean;
  okRuntimes: string[];
  selectedRuntime: string | null;
  setSelectedRuntime: (next: string | null) => void;
  visibility: AgentVisibility;
  setVisibility: (next: AgentVisibility) => void;
  error: string | null;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  // Team-aware headline fires when there's at least one other active
  // member in the org — i.e. the user is joining a populated team (the
  // common invitee case) rather than spinning up a solo space. Falls back
  // to the neutral copy for solo signups, where the "You've joined X" line
  // would read awkwardly. Replaces the prior
  // `joinPath === "invite" && teamName` check, which read from
  // sessionStorage and could desync from server reality on cross-tab /
  // cross-device resumes.
  const hasTeammates = orgHasOtherMembers && !!teamName;
  const computerReady =
    !!connectedClient && !!selectedRuntime && capabilitiesLoaded && okRuntimes.includes(selectedRuntime);

  const noRuntime = capabilitiesLoaded && okRuntimes.length === 0 && !!connectedClient;
  const nextStepText = !trimmedName
    ? "Next: name your agent."
    : !connectedClient
      ? "Next: connect the computer where they'll work."
      : noRuntime
        ? "Install Claude Code (or Codex) on that computer, then sign in."
        : !selectedRuntime
          ? "Detecting installed runtimes…"
          : "Ready to create.";

  useEffect(() => {
    if (trimmedName) return;
    nameInputRef.current?.focus();
  }, [trimmedName]);

  return (
    <>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)", maxWidth: 720 }}>
        {hasTeammates ? (
          <>
            You&apos;ve joined{" "}
            <span className="font-semibold" style={{ color: "var(--fg-2)" }}>
              {teamName}
            </span>
            . Let&apos;s set up your first agent.
          </>
        ) : (
          <>Let&apos;s set up your first agent.</>
        )}
      </p>

      <div style={{ marginTop: "var(--sp-5)", position: "relative" }}>
        <StepRailLine />

        <StepFrame number="01" state={trimmedName ? "complete" : "active"}>
          <div className="flex items-baseline" style={{ gap: "var(--sp-2)", flexWrap: "wrap" }}>
            <label
              htmlFor="onboarding-name"
              className="text-body font-normal"
              style={{ color: "var(--fg-2)", whiteSpace: "nowrap" }}
            >
              Name your agent
            </label>
            <input
              ref={nameInputRef}
              id="onboarding-name"
              aria-label="Agent display name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Buddy, Helper"
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

        <StepFrame number="02" state={computerReady ? "complete" : trimmedName ? "active" : "idle"}>
          <div style={{ animation: trimmedName ? "subtle-fade 200ms ease-out" : undefined }}>
            <h2
              className="text-subtitle font-semibold"
              style={{
                color: trimmedName ? "var(--fg)" : "var(--fg-4)",
                fontWeight: trimmedName ? 600 : 500,
              }}
            >
              Connect a computer
            </h2>

            {trimmedName ? (
              <>
                <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
                  {connectedClient
                    ? `${trimmedName} will run on this computer and stay connected to Hub.`
                    : `${trimmedName} needs a computer to run on. Connect one with the command below.`}
                </p>
                {!connectedClient && (
                  <p className="text-label" style={{ color: "var(--fg-4)", marginTop: "var(--sp-2)" }}>
                    Open Terminal on that computer and run this command.
                  </p>
                )}

                {connectedClient ? (
                  <>
                    <ConnectedRow hostname={connectedClient.hostname ?? connectedClient.id} />
                    <RuntimeChips
                      runtimes={okRuntimes}
                      selected={selectedRuntime}
                      onSelect={setSelectedRuntime}
                      capabilitiesLoaded={capabilitiesLoaded}
                    />
                  </>
                ) : (
                  <>
                    <CommandBox command={cliCommand} />
                    <WaitingRow />
                  </>
                )}
              </>
            ) : null}
          </div>
        </StepFrame>

        <StepFrame number="03" state={computerReady ? "active" : "idle"}>
          <div style={{ animation: computerReady ? "subtle-fade 200ms ease-out" : undefined }}>
            <h2
              className="text-subtitle font-semibold"
              style={{
                color: computerReady ? "var(--fg)" : "var(--fg-4)",
                fontWeight: computerReady ? 600 : 500,
              }}
            >
              Pick who can use it
            </h2>

            {computerReady ? <VisibilityPicker value={visibility} onChange={setVisibility} /> : null}
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

function CommandBox({ command }: { command: string | null }) {
  const [copied, setCopied] = useState(false);

  const lines = command ? command.split("\n") : [];
  const connectLine = lines.find((l) => l.startsWith("first-tree")) ?? "";
  const connectPrefix = "first-tree login ";
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

/**
 * "Powered by" runtime selector — appears under the connected-computer
 * row in Step 2. Auto-pinned to the preferred runtime (Claude Code →
 * Codex) via `pickPreferredRuntime`; the chips let the operator override
 * if they want the other one. Renders nothing useful while capabilities
 * are still loading or no `ok` runtime exists on the connected client.
 */
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
                  width: "var(--sp-3_5)",
                  height: "var(--sp-3_5)",
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
                      width: "var(--sp-1_5)",
                      height: "var(--sp-1_5)",
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

/**
 * Visibility radio for Step 2 — "Shared with team" vs "Private to you".
 * Copy is intentionally identical to NewAgentDialog (`new-agent-dialog.tsx`)
 * so the two surfaces describe the same product semantics with the same
 * words; only the default differs (onboarding defaults to "organization"
 * to lean into the agent-team framing; the dialog defaults to "private").
 *
 * Visual: card-style labels with an accent border + tinted background on
 * the active option — matches the multi-repo checkbox cards in
 * InviteeConfirmBody so the onboarding flow stays stylistically coherent.
 * Intentionally NOT a shared component (per spec) — the dialog uses
 * Tailwind utility classes while onboarding uses inline CSS-variable
 * styles, and forcing them through one component would muddy both.
 *
 * No "(default)" label on either option: radio selected-state already
 * conveys which one is picked, so the suffix is redundant noise.
 */
function VisibilityPicker({ value, onChange }: { value: AgentVisibility; onChange: (next: AgentVisibility) => void }) {
  const options: ReadonlyArray<{
    value: AgentVisibility;
    title: string;
    description: string;
  }> = [
    {
      value: "organization",
      title: "Shared with team",
      description: "Anyone in your org can @mention and chat with this agent.",
    },
    {
      value: "private",
      title: "Private to you",
      description: "Only you can see this agent and chat with it. Others on the team won't see it listed.",
    },
  ];
  return (
    <fieldset
      className="flex flex-col"
      style={{ gap: "var(--sp-2)", margin: "var(--sp-2) 0 0", padding: 0, border: 0 }}
    >
      <legend className="sr-only">Agent visibility</legend>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <label
            key={opt.value}
            className="text-body"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "var(--sp-2)",
              padding: "var(--sp-2) var(--sp-3)",
              background: active ? "color-mix(in oklch, var(--accent) 8%, var(--bg))" : "var(--bg)",
              border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-faint)",
              borderRadius: "var(--radius-input)",
              cursor: "pointer",
              color: active ? "var(--fg)" : "var(--fg-2)",
              transition: "background 120ms ease, border-color 120ms ease",
            }}
          >
            <input
              type="radio"
              name="onboarding-visibility"
              value={opt.value}
              checked={active}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className="inline-flex items-center justify-center"
              style={{
                width: "var(--sp-3_5)",
                height: "var(--sp-3_5)",
                marginTop: "var(--sp-0_5)",
                borderRadius: "50%",
                border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-strong)",
                background: active ? "color-mix(in oklch, var(--accent) 8%, transparent)" : "transparent",
                flexShrink: 0,
                transition: "border-color 160ms ease, background 160ms ease",
              }}
            >
              {active && (
                <span
                  style={{
                    width: "var(--sp-1_5)",
                    height: "var(--sp-1_5)",
                    borderRadius: "50%",
                    background: "var(--accent)",
                  }}
                />
              )}
            </span>
            <span className="flex flex-col" style={{ gap: "var(--sp-0_5)", minWidth: 0 }}>
              <span className="font-medium" style={{ color: active ? "var(--fg)" : "var(--fg-2)" }}>
                {opt.title}
              </span>
              <span className="text-label" style={{ color: "var(--fg-3)" }}>
                {opt.description}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
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
            <li>The runtime can&apos;t start on {computerLabel} (missing API key, etc.)</li>
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
