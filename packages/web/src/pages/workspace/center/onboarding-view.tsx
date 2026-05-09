import type { ClientCapabilities, LocalGitRepoSummary, OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { ArrowRight, Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getClientCapabilities, type HubClient, listClients } from "../../../api/activity.js";
import { getAgentConfig, updateAgentConfig } from "../../../api/agent-config.js";
import { listManagedAgents, type ManagedAgent } from "../../../api/agents.js";
import { createAgentChat, sendChatMessage } from "../../../api/chats.js";
import { api, withOrg } from "../../../api/client.js";
import { reportOnboardingEvent } from "../../../api/onboarding-events.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Button } from "../../../components/ui/button.js";
import { slugify } from "../../../utils/agent-naming.js";
import {
  clearOnboardingDraft,
  onboardingDraftScope,
  readOnboardingAgentUuid,
  readOnboardingDraft,
  readOnboardingJoinPath,
  readOnboardingReturnChatId,
  readStep1Confirmed,
  readStep3IntroDismissed,
  writeOnboardingAgentUuid,
  writeOnboardingDraft,
  writeOnboardingReturnChatId,
  writeStep1Confirmed,
  writeStep3IntroDismissed,
} from "../../../utils/onboarding-flags.js";

/**
 * Inline onboarding panel — body branches on `onboardingStep` + URL state +
 * a per-tab session-storage flag for the Step 1 acknowledgement, per
 * docs/new-user-onboarding-design.md §4.2 / §9.
 *
 *   stepOverride "team"  → Step1Body  (team rename)
 *   no override + step1 unconfirmed + onboardingStep "connect" + solo
 *                        → Step1Body
 *   onboardingStep "connect" / "create_agent"
 *                        → Step2Body  (agent form + computer connect)
 *   onboardingStep "completed" + Step 3 intro not dismissed (per-tab)
 *                        → Step3IntroBody
 *   onboardingStep "completed" + Step 3 intro dismissed
 *                        → Step3PlaceholderBody
 *
 * The OnboardingStepper at the workspace-shell level renders independently
 * from this view (visibility tied to `users.onboarding_dismissed_at`, not
 * `onboardingStep`). The chat-init transition (sub-state B) is handled by
 * `CenterPanel` routing — once `?c=<chatId>` is set, this view doesn't
 * render at all.
 */

const RUNTIME_READY_TIMEOUT_MS = 30_000;
const RUNTIME_READY_POLL_MS = 1_000;
const CLIENT_DETECT_POLL_MS = 3_000;

/**
 * Bootstrap message sent on the user's behalf when they click [Yes, set it
 * up] in Step 3 IntroBody. Verbose for a reason — the agent does NOT have
 * the first-tree skill loaded yet (installing it IS the goal of Step 3),
 * so the message must self-bootstrap the agent's knowledge of (a) which
 * CLI to use, (b) the action to take, (c) the URL to consult.
 *
 * Single source of truth shared with the NewAgentDialog auto-send and any
 * future first-tree install trigger. See docs/new-user-onboarding-design.md
 * §7.3 (decision O-6).
 */
const STEP3_BOOTSTRAP_MESSAGE =
  "Use the latest First-Tree CLI to install the skill in the current repository and complete the onboarding process: https://github.com/agent-team-foundation/first-tree";

type Phase = "form" | "creating" | "timeout";

function prettyRuntimeLabel(provider: string): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

type ResolvedBody = "step1" | "step2" | "step3-intro" | "step3-placeholder";

export function OnboardingView() {
  const { onboardingStep, refreshMe, organizationId, memberId, role } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const stepOverride = searchParams.get("step");
  const [joinPath] = useState(() => readOnboardingJoinPath());

  // Step 1 confirmation is a session-only flag — DB rows are pre-created at
  // OAuth time so the server can't distinguish "haven't confirmed yet" from
  // "confirmed days ago". Per-tab is fine: a user who reloads land on the
  // same machine still has the flag.
  const [step1Confirmed, setStep1ConfirmedState] = useState(() => readStep1Confirmed());
  const [step3IntroDismissed, setStep3IntroDismissedState] = useState(() => readStep3IntroDismissed());

  const setStep1Confirmed = useCallback((v: boolean) => {
    writeStep1Confirmed(v);
    setStep1ConfirmedState(v);
  }, []);
  const setStep3IntroDismissed = useCallback((v: boolean) => {
    writeStep3IntroDismissed(v);
    setStep3IntroDismissedState(v);
  }, []);

  // When the user clicks the "Tree" pip in the stepper, OnboardingStepper
  // sets ?step=tree. That intent should re-show the intro card (per O-5).
  useEffect(() => {
    if (stepOverride === "tree") setStep3IntroDismissed(false);
  }, [stepOverride, setStep3IntroDismissed]);

  // Step 1's PATCH /orgs/:id is gated by `requireOrgAdmin` server-side, so a
  // non-admin member who somehow lands on Step 1 (lost joinPath flag,
  // clicked the stepper pip) would just hit a 403. Skip Step 1 for them
  // entirely — they joined an existing team and the team-rename pillar
  // doesn't apply.
  const canRenameTeam = role === "admin";

  const body = useMemo<ResolvedBody>(() => {
    if (stepOverride === "team" && canRenameTeam) return "step1";
    if (stepOverride === "agent") return "step2";
    if (stepOverride === "tree") return step3IntroDismissed ? "step3-placeholder" : "step3-intro";
    if (onboardingStep === "completed") {
      return step3IntroDismissed ? "step3-placeholder" : "step3-intro";
    }
    if (onboardingStep === "connect" && !step1Confirmed && joinPath !== "invite" && canRenameTeam) {
      return "step1";
    }
    return "step2";
  }, [stepOverride, onboardingStep, step1Confirmed, step3IntroDismissed, joinPath, canRenameTeam]);

  const advanceToStep2 = useCallback(() => {
    setStep1Confirmed(true);
    const next = new URLSearchParams(searchParams);
    next.delete("step");
    // If the user got here by clicking Step 1 from inside a Step 3 chat,
    // bounce them back to that chat instead of `/` so they don't lose
    // their tree-init conversation. One-shot — clear after consuming.
    const returnChatId = readOnboardingReturnChatId();
    if (returnChatId) {
      writeOnboardingReturnChatId(null);
      next.set("c", returnChatId);
    }
    setSearchParams(next, { replace: true });
  }, [setStep1Confirmed, searchParams, setSearchParams]);

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
        {body === "step1" ? (
          <Step1Body organizationId={organizationId} onContinue={advanceToStep2} />
        ) : body === "step2" ? (
          <Step2Body organizationId={organizationId} memberId={memberId} joinPath={joinPath} refreshMe={refreshMe} />
        ) : body === "step3-intro" ? (
          <Step3IntroBody
            onLater={() => {
              void reportOnboardingEvent("tree_intro_dismissed");
              setStep3IntroDismissed(true);
            }}
          />
        ) : (
          <Step3PlaceholderBody onReopen={() => setStep3IntroDismissed(false)} />
        )}
      </div>
    </div>
  );
}

// ─── Step 1 ──────────────────────────────────────────────────────────────

function Step1Body({ organizationId, onContinue }: { organizationId: string | null; onContinue: () => void }) {
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [name, setName] = useState("");
  const [initialName, setInitialName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
    const seed = orgs.find((o) => o.id === organizationId)?.displayName ?? "";
    setName(seed);
    setInitialName(seed);
  }, [orgs, organizationId]);

  // Focus the input + place caret at end once the seed value lands (per §5.1).
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !initialName) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [initialName]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !saving;

  const handleSubmit = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      if (!canSubmit || !organizationId) return;
      setError(null);
      try {
        const renamed = trimmed !== initialName.trim();
        if (renamed) {
          setSaving(true);
          await api.patch(`/orgs/${encodeURIComponent(organizationId)}`, {
            displayName: trimmed,
          });
          void reportOnboardingEvent("team_renamed");
        }
        onContinue();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to rename team");
      } finally {
        setSaving(false);
      }
    },
    [canSubmit, organizationId, trimmed, initialName, onContinue],
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        Welcome to your <span style={{ color: "var(--fg-2)" }}>agent team</span> — where humans and AIs collaborate.
        Let&apos;s name it.
      </p>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="onboarding-team-name" className="text-label" style={{ color: "var(--fg-3)" }}>
          Team name
        </label>
        <input
          ref={inputRef}
          id="onboarding-team-name"
          aria-label="Team display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          disabled={saving}
          className="text-body"
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            background: "var(--bg)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg)",
            outline: "none",
            caretColor: "var(--accent)",
          }}
          onFocus={(event) => {
            event.currentTarget.style.borderColor = "var(--accent)";
          }}
          onBlur={(event) => {
            event.currentTarget.style.borderColor = "var(--border)";
          }}
        />
      </div>

      {error ? (
        <div
          className="text-body"
          style={{
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--state-error)",
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={!canSubmit}>
          <span>Continue</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

// ─── Step 2 ──────────────────────────────────────────────────────────────

function Step2Body({
  organizationId,
  memberId,
  joinPath,
  refreshMe,
}: {
  organizationId: string | null;
  memberId: string | null;
  joinPath: "solo" | "invite" | null;
  refreshMe: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const draftScope = onboardingDraftScope(organizationId, memberId);
  const initialDraft = readOnboardingDraft(draftScope);
  const initialConnectToken =
    initialDraft?.connectToken && initialDraft.connectTokenExpiresAt && initialDraft.connectTokenExpiresAt > Date.now()
      ? initialDraft.connectToken
      : null;
  const initialConnectTokenExpiresAt = initialConnectToken ? (initialDraft?.connectTokenExpiresAt ?? null) : null;

  // Pre-fill with `Coder` so a user who doesn't care about naming can hit
  // Continue immediately. Mirrors the Step 1 default `{login}'s team`.
  const [displayName, setDisplayName] = useState(() => initialDraft?.displayName ?? "Coder");
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(() => initialDraft?.selectedRuntime ?? null);
  const [connectedClient, setConnectedClient] = useState<HubClient | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(() => initialConnectToken);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(() => initialConnectTokenExpiresAt);
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
      selectedRepoUrl: null,
    });
  }, [draftScope, displayName, selectedRuntime, connectToken, connectTokenExpiresAt]);

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
        const r = await api.post<{ token: string; expiresIn: number }>("/me/connect-tokens", {});
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
      // Repo is picked in Step 3 (where it's actually used as the
      // context-tree anchor) — not here. The agent ships with empty
      // `gitRepos`; Step3IntroBody PATCHes the config before creating
      // the chat session.
      const res = await api.post<{ uuid: string }>(withOrg("/agents"), {
        type: "personal_assistant",
        displayName: trimmedName,
        ...(slug ? { name: slug } : {}),
        clientId: connectedClient.id,
        runtimeProvider: selectedRuntime,
        ...(organizationId ? { organizationId } : {}),
      });
      agentUuid = res.uuid;
      createdAgentRef.current = agentUuid;
      writeOnboardingAgentUuid(agentUuid);
      void reportOnboardingEvent("agent_created", { runtimeProvider: selectedRuntime });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setPhase("form");
      return;
    }

    await pollUntilReady(agentUuid);
  }, [trimmedName, connectedClient, selectedRuntime, pollUntilReady, organizationId]);

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
      joinPath={joinPath}
      teamName={teamName}
      displayName={displayName}
      setDisplayName={setDisplayName}
      trimmedName={trimmedName}
      connectedClient={connectedClient}
      cliCommand={cliCommand}
      capabilitiesLoaded={activeCapabilities !== null}
      okRuntimes={okRuntimes}
      selectedRuntime={selectedRuntime}
      onSelectRuntime={setSelectedRuntime}
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
  joinPath,
  teamName,
  displayName,
  setDisplayName,
  trimmedName,
  connectedClient,
  cliCommand,
  capabilitiesLoaded,
  okRuntimes,
  selectedRuntime,
  onSelectRuntime,
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
  capabilitiesLoaded: boolean;
  okRuntimes: string[];
  selectedRuntime: string | null;
  onSelectRuntime: (next: string) => void;
  error: string | null;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const inviteHasTeam = joinPath === "invite" && teamName;

  const noRuntime = capabilitiesLoaded && okRuntimes.length === 0 && !!connectedClient;
  // Step 2 has only Name + Computer now; repo selection moved to Step 3
  // where it actually feeds the context-tree anchor.
  const nextStepText = !trimmedName
    ? "Next: name your agent."
    : !connectedClient
      ? "Next: connect the computer where this agent will run."
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
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)", maxWidth: 540 }}>
        {inviteHasTeam ? (
          <>
            You&apos;ve joined{" "}
            <span className="font-semibold" style={{ color: "var(--fg-2)" }}>
              {teamName}
            </span>
            . Let&apos;s set up your first agent — a{" "}
            <span className="font-semibold" style={{ color: "var(--fg-2)" }}>
              code agent
            </span>{" "}
            that helps with your code.
          </>
        ) : (
          <>
            Let&apos;s set up your first agent — a{" "}
            <span className="font-semibold" style={{ color: "var(--fg-2)" }}>
              code agent
            </span>{" "}
            that helps with your code.
          </>
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

        <StepFrame
          number="02"
          state={connectedClient && selectedRuntime ? "complete" : trimmedName ? "active" : "idle"}
        >
          <div style={{ animation: trimmedName ? "subtle-fade 200ms ease-out" : undefined }}>
            <h2
              className="text-subtitle font-semibold"
              style={{
                color: trimmedName ? "var(--fg)" : "var(--fg-4)",
                fontWeight: trimmedName ? 600 : 500,
              }}
            >
              Which computer should it run on?
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

                {connectedClient ? (
                  <RuntimeChips
                    runtimes={okRuntimes}
                    selected={selectedRuntime}
                    onSelect={onSelectRuntime}
                    capabilitiesLoaded={capabilitiesLoaded}
                  />
                ) : null}
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

// ─── Step 3 ──────────────────────────────────────────────────────────────

type ResolvedAgent = ManagedAgent;

/**
 * Resolve the onboarding agent in priority order:
 *   1. The UUID stashed at Step 2 success.
 *   2. Most recently created managed agent (uuidv7 sort).
 *   3. Any non-human managed agent.
 */
async function resolveOnboardingAgent(): Promise<ResolvedAgent | null> {
  const stashedUuid = readOnboardingAgentUuid();
  const managed = await listManagedAgents();
  const nonHuman = managed.filter((a) => a.type !== "human");
  return (
    (stashedUuid ? managed.find((a) => a.uuid === stashedUuid) : undefined) ??
    nonHuman.slice().sort((a, b) => b.uuid.localeCompare(a.uuid))[0] ??
    managed[0] ??
    null
  );
}

/**
 * Discriminated picker selection. The `kind` distinguishes the two paths
 * because their state machines differ — typing in the manual input must not
 * unset a list pick, and clearing it must not unset a list pick either.
 */
type LocalSelection =
  | { kind: "list"; localPath: string; originUrl: string; name: string }
  | { kind: "manual"; localPath: string };

/**
 * Mirror of the client-side `isAbsoluteLocalPath` predicate. Step 3 must
 * refuse to PATCH `gitRepos[].localPath` with a relative string — the
 * client handler only takes the local-direct branch when the path is
 * absolute, and a relative path falls through to the legacy sandbox branch
 * (which then tries to `git clone "local://relative/path"` and fails in a
 * confusing way).
 */
function isAbsoluteRepoPath(p: string): boolean {
  if (!p) return false;
  return p === "~" || p.startsWith("~/") || p.startsWith("/");
}

function Step3IntroBody({ onLater }: { onLater: () => void }) {
  const navigate = useNavigate();
  const { dismissOnboarding } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<ResolvedAgent | null>(null);
  const [agentResolveError, setAgentResolveError] = useState<string | null>(null);
  const [localRepos, setLocalRepos] = useState<LocalGitRepoSummary[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LocalSelection | null>(null);
  const [manualPath, setManualPath] = useState("");

  // Resolve the agent + its bound client up front. The Step 2 flow stashes
  // the agent uuid in sessionStorage and pins it to a client — so by the
  // time we arrive in Step 3 both should be available. If the user has no
  // managed agent yet (rare race), surface a clear error and let them
  // retry by re-entering Step 3.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const a = await resolveOnboardingAgent();
        if (cancelled) return;
        if (!a) {
          setAgentResolveError("No agent available — finish Step 2 first.");
          return;
        }
        setAgent(a);
        if (!a.clientId) {
          // Agent exists but isn't pinned to a client. We can't list local
          // repos in that case; degrade to manual-path-only mode.
          setLocalRepos([]);
          setReposError("Your agent isn't connected to a computer yet — type the repo path manually below.");
          return;
        }
        const detail = await getClientCapabilities(a.clientId);
        if (cancelled) return;
        setLocalRepos(detail.localGitRepos ?? []);
      } catch (err) {
        if (!cancelled) {
          setReposError(err instanceof Error ? err.message : "Failed to list local repositories");
          setLocalRepos([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleYes = useCallback(async () => {
    if (!selected || !agent) return;
    setError(null);
    setBusy(true);
    try {
      // Bind the picked repo BEFORE creating the chat session so the
      // agent's `prepareGitWorktrees` step sees a non-empty `gitRepos`
      // payload (with `localPath` absolute) when the first message arrives.
      // Sequential await is sufficient — no race because chat creation is
      // the next line.
      const cfg = await getAgentConfig(agent.uuid);
      // url is identity-only when localPath is absolute (handler skips the
      // Hub mirror clone entirely). Use the working clone's origin URL
      // when known, fall back to a `local:` URI built from the path so
      // the schema's `url.min(1)` invariant is satisfied without inventing
      // a misleading https:// URL.
      const knownOrigin = selected.kind === "list" ? selected.originUrl : "";
      const url = knownOrigin || `local://${selected.localPath}`;
      await updateAgentConfig(agent.uuid, {
        expectedVersion: cfg.version,
        payload: { gitRepos: [{ url, localPath: selected.localPath }] },
      });

      const chat = await createAgentChat(agent.uuid);
      // Best-effort: if the bootstrap message fails (e.g. transient network
      // hiccup), the user still lands in the empty chat and can retype.
      try {
        await sendChatMessage(chat.id, STEP3_BOOTSTRAP_MESSAGE);
      } catch {
        // intentionally non-fatal
      }
      void reportOnboardingEvent("tree_chat_started", { agentUuid: agent.uuid, chatId: chat.id });
      // Step 3 succeeded — onboarding is now naturally complete. Auto-dismiss
      // the stepper so it doesn't linger on top of the user's first chat.
      // Best-effort; failure here doesn't block navigation. The "Resume
      // setup" entry in Settings → Setup can bring it back if needed.
      void dismissOnboarding();
      navigate(`/?c=${encodeURIComponent(chat.id)}`, { replace: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the tree-init chat");
      setBusy(false);
    }
  }, [selected, agent, navigate, dismissOnboarding]);

  const canStart = !!selected && !!agent && !busy;

  return (
    <>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        Build your <span style={{ color: "var(--fg-2)" }}>context-tree</span> with your agent — your team&apos;s shared
        knowledge that grows with your code.
      </p>

      <div style={{ marginTop: "var(--sp-5)", position: "relative" }}>
        <StepRailLine />

        <StepFrame number="01" state={selected ? "complete" : "active"}>
          <h2 className="text-subtitle font-semibold" style={{ margin: 0, color: "var(--fg)" }}>
            Which repository should your context-tree live next to?
          </h2>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            Pick a repo on your computer — your agent works on a session branch in that repo, so the tree lands next to
            your code.
          </p>
          <div style={{ marginTop: "var(--sp-2)" }}>
            <LocalRepoPickerBody
              repos={localRepos}
              error={reposError}
              selected={selected}
              onSelect={setSelected}
              manualPath={manualPath}
              onManualPathChange={setManualPath}
            />
          </div>
        </StepFrame>

        <StepFrame number="02" state={selected ? "active" : "idle"}>
          <h2
            className="text-subtitle font-semibold"
            style={{
              margin: 0,
              color: selected ? "var(--fg)" : "var(--fg-4)",
              fontWeight: selected ? 600 : 500,
            }}
          >
            Pair with your agent to build the tree
          </h2>
          <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
            The agent you just set up will scaffold the sibling repo, install the first-tree skill, and write binding
            metadata on a session branch you can review.
          </p>
          {error || agentResolveError ? (
            <div
              className="text-body"
              style={{
                marginTop: "var(--sp-2)",
                padding: "var(--sp-2_5) var(--sp-3)",
                background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
                border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
                borderRadius: "var(--radius-input)",
                color: "var(--state-error)",
              }}
            >
              {error || agentResolveError}
            </div>
          ) : null}
          <div className="flex" style={{ marginTop: "var(--sp-3)", gap: "var(--sp-2)" }}>
            <Button type="button" disabled={!canStart} onClick={() => void handleYes()}>
              {busy ? "Starting…" : "Yes, build it"}
            </Button>
            <Button type="button" variant="outline" onClick={onLater} disabled={busy}>
              I&apos;ll do it later
            </Button>
          </div>
        </StepFrame>
      </div>
    </>
  );
}

function Step3PlaceholderBody({ onReopen }: { onReopen: () => void }) {
  return (
    <button
      type="button"
      onClick={onReopen}
      className="flex w-full text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-4)",
        color: "var(--fg-3)",
        background: "transparent",
        border: "none",
        borderRadius: "var(--radius-input)",
        cursor: "pointer",
      }}
    >
      <p className="text-body" style={{ margin: 0 }}>
        Click <span className="font-semibold">Build your context-tree</span> in the stepper above when you&apos;re
        ready.
      </p>
    </button>
  );
}

// ─── Shared Step 2 visual primitives ─────────────────────────────────────

/**
 * Step 3 picker — pick from the user's local clones (scanned by the client
 * at startup, surfaced via `clients.localGitRepos`). Filter input narrows
 * the list as it grows; manual-path input is the escape hatch for repos
 * outside the scanner's roots.
 */
function LocalRepoPickerBody({
  repos,
  error,
  selected,
  onSelect,
  manualPath,
  onManualPathChange,
}: {
  repos: LocalGitRepoSummary[] | null;
  error: string | null;
  selected: LocalSelection | null;
  onSelect: (sel: LocalSelection | null) => void;
  manualPath: string;
  onManualPathChange: (value: string) => void;
}) {
  const [filter, setFilter] = useState("");

  const trimmedManual = manualPath.trim();
  const manualIsAbsolute = trimmedManual === "" ? null : isAbsoluteRepoPath(trimmedManual);

  const handleManualChange = useCallback(
    (value: string) => {
      onManualPathChange(value);
      const trimmed = value.trim();
      // Only the manual-path branch is allowed to clear/set itself; never
      // unset a list pick from typing here. The discriminator on
      // `LocalSelection` makes this contractually clear.
      if (!trimmed || !isAbsoluteRepoPath(trimmed)) {
        if (selected?.kind === "manual") onSelect(null);
        return;
      }
      onSelect({ kind: "manual", localPath: trimmed });
    },
    [onSelect, onManualPathChange, selected],
  );

  const filtered = useMemo(() => {
    if (!repos) return null;
    const needle = filter.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.localPath.toLowerCase().includes(needle) ||
        r.originUrl.toLowerCase().includes(needle),
    );
  }, [repos, filter]);

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      {repos === null ? (
        <p className="text-label" style={{ color: "var(--fg-3)", margin: 0 }}>
          Loading repositories from your computer…
        </p>
      ) : (
        <>
          {repos.length > 0 ? (
            <>
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter by name…"
                aria-label="Filter local repositories"
                className="text-body"
                style={{
                  padding: "var(--sp-2) var(--sp-3)",
                  background: "var(--bg)",
                  border: "var(--hairline) solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--fg)",
                  outline: "none",
                }}
              />
              <ul
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  maxHeight: 240,
                  overflow: "auto",
                  border: "var(--hairline) solid var(--border-faint)",
                  borderRadius: "var(--radius-input)",
                  background: "var(--bg)",
                }}
              >
                {filtered && filtered.length === 0 ? (
                  <li className="text-label" style={{ padding: "var(--sp-2_5) var(--sp-3)", color: "var(--fg-4)" }}>
                    No matches.
                  </li>
                ) : (
                  (filtered ?? []).map((r) => {
                    const isSelected = selected?.kind === "list" && selected.localPath === r.localPath;
                    return (
                      <li key={r.localPath}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelect({
                              kind: "list",
                              localPath: r.localPath,
                              originUrl: r.originUrl,
                              name: r.name,
                            });
                            onManualPathChange("");
                          }}
                          className="flex w-full items-center text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          style={{
                            padding: "var(--sp-2) var(--sp-3)",
                            gap: "var(--sp-2)",
                            background: isSelected ? "var(--bg-active)" : "transparent",
                            border: "none",
                            cursor: "pointer",
                          }}
                        >
                          <span className="flex-1 min-w-0">
                            <span
                              className="text-body"
                              style={{
                                color: "var(--fg)",
                                fontWeight: isSelected ? 600 : 400,
                                display: "block",
                              }}
                            >
                              {r.name}
                            </span>
                            <span className="text-caption" style={{ color: "var(--fg-4)", display: "block" }}>
                              {r.localPath}
                            </span>
                          </span>
                          {isSelected ? <Check className="h-4 w-4" style={{ color: "var(--accent)" }} /> : null}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          ) : null}

          {error ? (
            <p className="text-label" style={{ color: "var(--fg-3)", margin: 0 }}>
              {error}
            </p>
          ) : null}

          {repos.length === 0 && !error ? (
            <p className="text-label" style={{ color: "var(--fg-3)", margin: 0 }}>
              No repos detected under common roots (~/code, ~/github, ~/projects, ~/work). Type a path below.
            </p>
          ) : null}

          <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
            <label htmlFor="onboarding-manual-repo-path" className="text-label" style={{ color: "var(--fg-3)" }}>
              {repos.length > 0 ? "Not in the list?" : "Repository path"}
            </label>
            <input
              id="onboarding-manual-repo-path"
              type="text"
              value={manualPath}
              onChange={(e) => handleManualChange(e.target.value)}
              placeholder="/Users/you/code/your-repo"
              className="text-body"
              style={{
                padding: "var(--sp-2) var(--sp-3)",
                background: "var(--bg)",
                border: "var(--hairline) solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--fg)",
                outline: "none",
                fontFamily: "var(--font-mono)",
              }}
            />
            <p
              className="text-caption"
              style={{
                color: manualIsAbsolute === false ? "var(--state-error)" : "var(--fg-4)",
                margin: 0,
              }}
            >
              {manualIsAbsolute === false
                ? "Path must be absolute — start with / or ~/."
                : "Absolute path on the computer running your agent."}
            </p>
          </div>
        </>
      )}
    </div>
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

function CommandBox({ command }: { command: string | null }) {
  const [copied, setCopied] = useState(false);

  // The command is two lines: `npm install -g <pkg>` then the connect call.
  // Show both — installing the CLI is a prerequisite the user otherwise
  // misses. Truncate the connect token in the visible preview to keep the
  // box from wrapping; the Copy button still grabs the verbatim string.
  const lines = command ? command.split("\n") : [];
  const installLine = lines.find((l) => l.startsWith("npm ")) ?? "";
  const connectLine = lines.find((l) => l.startsWith("first-tree-hub")) ?? "";
  const connectPrefix = "first-tree-hub connect ";
  const connectPreview = connectLine.startsWith(connectPrefix)
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
          title={command ?? ""}
          style={{
            flex: 1,
            margin: 0,
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--bg-sunken) 42%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--border-faint) 58%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg-2)",
            whiteSpace: "pre",
            overflow: "hidden",
            minWidth: 0,
            lineHeight: 1.5,
          }}
        >
          {command ? `${installLine}\n${connectPreview}` : "Generating token…"}
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
