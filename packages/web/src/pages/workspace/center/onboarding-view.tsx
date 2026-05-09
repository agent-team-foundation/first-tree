import type { ClientCapabilities, OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { ArrowRight, Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { getClientCapabilities, type HubClient, listClients } from "../../../api/activity.js";
import { getAgentConfig, updateAgentConfig } from "../../../api/agent-config.js";
import { listManagedAgents } from "../../../api/agents.js";
import { createAgentChat, sendChatMessage } from "../../../api/chats.js";
import { api, withOrg } from "../../../api/client.js";
import { type GithubRepo, listGithubRepos } from "../../../api/github.js";
import { reportOnboardingEvent } from "../../../api/onboarding-events.js";
import { putContextTreeSetting } from "../../../api/org-settings.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Button } from "../../../components/ui/button.js";
import { useToast } from "../../../components/ui/toast.js";
import { slugify } from "../../../utils/agent-naming.js";
import {
  clearOnboardingDraft,
  onboardingDraftScope,
  readOnboardingAgentUuid,
  readOnboardingDraft,
  readOnboardingJoinPath,
  readStep1Confirmed,
  writeOnboardingAgentUuid,
  writeOnboardingDraft,
  writeStep1Confirmed,
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
 *   onboardingStep "completed"
 *                        → Step3IntroBody  (CTA "Set up first-tree?")
 *
 * Visibility of this view is gated by `CenterPanel`:
 * `onboardingStep !== null && !onboardingDismissedAt`. "I'll do it later"
 * and the stepper `✕` both PATCH `onboardingDismissedAt = now()` (and emit
 * a toast pointing at Settings → Setup), so dismiss behaviour is uniform —
 * server-side and cross-tab. There is no per-tab "dismiss Step 3 intro"
 * state any more.
 *
 * The OnboardingStepper at the workspace-shell level renders independently
 * (visibility tied to `users.onboarding_dismissed_at`, not `onboardingStep`).
 * The chat-init transition (sub-state B) is handled by `CenterPanel` routing —
 * once `?c=<chatId>` is set, this view doesn't render at all.
 */

const RUNTIME_READY_TIMEOUT_MS = 30_000;
const RUNTIME_READY_POLL_MS = 1_000;
const CLIENT_DETECT_POLL_MS = 3_000;

/**
 * Two bootstrap-message variants Step 3 IntroBody dispatches based on the
 * user's "do you already have a tree?" choice. Prose, not shell recipes —
 * the agent has the first-tree skill (and the source repo, materialised
 * via `gitRepos`) ready in its workspace, so the message just describes
 * the goal and references the CLI surfaces by name. The skill knows the
 * concrete commands.
 *
 * Path A (existing tree) skips Hub bookkeeping at the end — the web
 * frontend already PUT the URL into the org's `context_tree` settings
 * namespace before sending the chat. Path B (new tree) tells the agent
 * to call back into the first-tree-hub CLI to record the freshly created
 * URL.
 *
 * Single source of truth: only Step 3 IntroBody currently sends these.
 * If a future surface needs the same prompts, hoist these builders to
 * `packages/shared` so both import the same strings.
 */
const FIRST_TREE_REFERENCE_URL = "https://github.com/agent-team-foundation/first-tree";

function buildBindBootstrap(sourceUrl: string, treeUrl: string): string {
  return [
    "Bind my source repo to an existing context-tree.",
    "",
    `Source repo: ${sourceUrl}`,
    `Existing tree: ${treeUrl}`,
    "",
    "Your working directory already has the source repo cloned. Use the first-tree CLI to install the skill in the source repo and write the binding metadata pointing at the existing tree, then open a PR back to the source with those changes. Walk me through the PR when it's up.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}

function buildCreateBootstrap(sourceUrl: string): string {
  return [
    "Create a brand-new context-tree for my source repo.",
    "",
    `Source repo: ${sourceUrl}`,
    "",
    "Your working directory already has the source repo cloned. Use the first-tree CLI to install the skill in the source, scaffold a sibling tree directory, and write the binding metadata. Then push that new tree directory up to GitHub as a sibling repo under the same owner as the source, and open a PR back to the source with the skill + binding files.",
    "",
    "Once you know the URL of the new tree repo, use the first-tree-hub CLI's `org bind-tree` command to record it on the Hub so future agents in this team can find it.",
    "",
    "When everything is up, walk me through what was created — which directory, which repo, which PR.",
    "",
    `Reference: ${FIRST_TREE_REFERENCE_URL}`,
  ].join("\n");
}

type Phase = "form" | "creating" | "timeout";

type ResolvedBody = "step1" | "step2" | "step3-intro";

function prettyRuntimeLabel(provider: string): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "codex") return "Codex";
  return provider;
}

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

  const setStep1Confirmed = useCallback((v: boolean) => {
    writeStep1Confirmed(v);
    setStep1ConfirmedState(v);
  }, []);

  // Step 1's PATCH /orgs/:id is gated by `requireOrgAdmin` server-side, so a
  // non-admin member who somehow lands on Step 1 (lost joinPath flag,
  // clicked the stepper pip) would just hit a 403. Skip Step 1 for them
  // entirely — they joined an existing team and the team-rename pillar
  // doesn't apply.
  const canRenameTeam = role === "admin";

  const body = useMemo<ResolvedBody>(() => {
    if (stepOverride === "team" && canRenameTeam) return "step1";
    if (stepOverride === "agent") return "step2";
    if (stepOverride === "tree") return "step3-intro";
    if (onboardingStep === "completed") return "step3-intro";
    if (onboardingStep === "connect" && !step1Confirmed && joinPath !== "invite" && canRenameTeam) {
      return "step1";
    }
    return "step2";
  }, [stepOverride, onboardingStep, step1Confirmed, joinPath, canRenameTeam]);

  const advanceToStep2 = useCallback(() => {
    setStep1Confirmed(true);
    const next = new URLSearchParams(searchParams);
    next.delete("step");
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
      <div style={{ width: "100%", maxWidth: 720 }}>
        {body === "step1" ? (
          <Step1Body organizationId={organizationId} onContinue={advanceToStep2} />
        ) : body === "step2" ? (
          <Step2Body organizationId={organizationId} memberId={memberId} joinPath={joinPath} refreshMe={refreshMe} />
        ) : (
          <Step3IntroBody />
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
  // Distinguish "still loading the seed name" from "loaded but the user
  // emptied the input" — without this distinction we can't tell whether
  // to disable Continue defensively (load failed → don't let them PATCH a
  // typed-by-hand name that overwrites the auto-generated default they
  // never saw).
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [orgsLoadError, setOrgsLoadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch (err) {
        setOrgsLoadError(err instanceof Error ? err.message : "Failed to load your team");
      } finally {
        setOrgsLoaded(true);
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
  // Refuse to submit while orgs haven't loaded (we don't know the seed) or
  // while the load errored out (the user is staring at an empty input we
  // can't seed — letting them PATCH would overwrite the auto-generated
  // name they never saw).
  const canSubmit = trimmed.length > 0 && !saving && orgsLoaded && !orgsLoadError;

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
        Name your <span style={{ color: "var(--fg-2)" }}>agent team</span> — where humans and AIs collaborate.
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

      {error || orgsLoadError ? (
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
          {error ?? `Couldn't load your team — ${orgsLoadError}. Refresh the page and try again.`}
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

  // Default agent name: "Coder" — most onboarding agents are code agents
  // (per the Step 2 lead). User can rename in the input or via agent
  // settings later. The draft override wins so we don't clobber a name
  // a returning user already typed.
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
        repoBound: false,
      });
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
      setSelectedRuntime={setSelectedRuntime}
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
  setSelectedRuntime,
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
  setSelectedRuntime: (next: string | null) => void;
  error: string | null;
  canCreate: boolean;
  onCreate: () => void;
}) {
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const inviteHasTeam = joinPath === "invite" && teamName;

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
        {inviteHasTeam ? (
          <>
            You&apos;ve joined{" "}
            <span className="font-semibold" style={{ color: "var(--fg-2)" }}>
              {teamName}
            </span>
            . Set up your first agent — a{" "}
            <span className="font-semibold" style={{ color: "var(--fg-2)" }}>
              code agent
            </span>{" "}
            that helps with your code.
          </>
        ) : (
          <>
            Set up your first agent — a{" "}
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
              Name your agent
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

type TreeMode = "existing" | "new";

function Step3IntroBody() {
  const navigate = useNavigate();
  const { dismissOnboarding, organizationId } = useAuth();
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [treeMode, setTreeMode] = useState<TreeMode | null>(null);
  const [existingTreeUrl, setExistingTreeUrl] = useState("");
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | null>(null);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);

  // Lazy-load the GitHub repo list once when Step 3 mounts. Plan B keeps
  // source picker here (not Step 2) so agent creation in Step 2 stays
  // independent of GitHub OAuth health — agent already exists by the time
  // this runs, so an OAuth hiccup only blocks Step 3, not the user's
  // entire onboarding.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listGithubRepos();
        if (cancelled) return;
        setRepos(list);
      } catch (err) {
        if (!cancelled) setReposError(err instanceof Error ? err.message : "Failed to list GitHub repositories");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedTreeUrl = existingTreeUrl.trim();
  const isExistingUrlValid = (() => {
    if (treeMode !== "existing") return true;
    if (!trimmedTreeUrl) return false;
    try {
      const u = new URL(trimmedTreeUrl);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  })();

  const showSetupHiddenToast = useCallback(() => {
    addToast({
      title: "Setup hidden",
      description:
        "Resume any time in Settings → Setup. Your agent isn't bound to a source repo yet — add one in Agent settings when ready.",
      action: { label: "Open settings", onClick: () => navigate("/settings/setup") },
    });
  }, [addToast, navigate]);

  // "I'll do it later" — server dismiss + toast. Same recovery path as
  // clicking the stepper `✕` (single source of truth, server-side flag).
  // The toast also nudges the user about the unbound source repo (Plan B
  // moves source picker into Step 3, so skipping leaves the agent without
  // an explicit code repo binding).
  const handleLater = useCallback(() => {
    void reportOnboardingEvent("tree_intro_dismissed");
    void dismissOnboarding();
    showSetupHiddenToast();
  }, [dismissOnboarding, showSetupHiddenToast]);

  const handleContinue = useCallback(async () => {
    if (!selectedRepoUrl) return;
    if (!treeMode) return;
    if (treeMode === "existing" && !isExistingUrlValid) return;
    setError(null);
    setBusy(true);
    try {
      // Resolve the onboarding agent in priority order:
      //   1. The UUID stashed at Step 2 success.
      //   2. Most recently created managed agent (UUID v7 sort desc).
      //   3. Any non-human managed agent.
      const stashedUuid = readOnboardingAgentUuid();
      const managed = await listManagedAgents();
      const nonHuman = managed.filter((a) => a.type !== "human");
      const agent =
        (stashedUuid ? managed.find((a) => a.uuid === stashedUuid) : undefined) ??
        nonHuman.slice().sort((a, b) => b.uuid.localeCompare(a.uuid))[0] ??
        managed[0];
      if (!agent) {
        throw new Error("No agent available to chat with — finish Step 2 first.");
      }

      // Plan B: bind the source repo to the agent NOW (before chat starts)
      // so `prepareGitWorktrees` can clone it on session start. Step 2
      // creates an unbound agent; Step 3 is where the binding happens.
      // Sequential await — chat creation below races the runtime config
      // PATCH otherwise.
      const cfg = await getAgentConfig(agent.uuid);
      await updateAgentConfig(agent.uuid, {
        expectedVersion: cfg.version,
        payload: { gitRepos: [{ url: selectedRepoUrl }] },
      });

      // Path A: persist the existing tree URL to the org NOW via the
      // generic per-org settings surface (`context_tree` namespace). Agent
      // will still write `.first-tree/local-tree.json` to the source repo
      // via PR (proper binding), but Hub already has the URL cached so
      // future agents in this org can find it without re-reading source
      // files.
      if (treeMode === "existing" && organizationId) {
        try {
          await putContextTreeSetting(organizationId, { repo: trimmedTreeUrl });
        } catch (err) {
          // Non-fatal — the agent will still bind in chat. Log + continue.
          // eslint-disable-next-line no-console
          console.warn("Step 3: PUT context_tree settings failed; agent will still proceed", err);
        }
      }

      const chat = await createAgentChat(agent.uuid);
      const bootstrap =
        treeMode === "existing"
          ? buildBindBootstrap(selectedRepoUrl, trimmedTreeUrl)
          : buildCreateBootstrap(selectedRepoUrl);
      try {
        await sendChatMessage(chat.id, bootstrap);
      } catch {
        // intentionally non-fatal — user lands in the empty chat
      }
      void reportOnboardingEvent("tree_chat_started", {
        agentUuid: agent.uuid,
        chatId: chat.id,
        treeMode,
      });
      // Step 3 launched — auto-dismiss the stepper so it doesn't linger
      // above the user's first chat. No toast here (mid-success path).
      void dismissOnboarding();
      navigate(`/?c=${encodeURIComponent(chat.id)}`, { replace: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the tree-init chat");
      setBusy(false);
    }
  }, [selectedRepoUrl, treeMode, isExistingUrlValid, trimmedTreeUrl, organizationId, navigate, dismissOnboarding]);

  const canContinue = !!selectedRepoUrl && treeMode !== null && !busy && (treeMode === "new" || isExistingUrlValid);

  const treeModeChosen = !!treeMode && (treeMode === "new" || isExistingUrlValid);

  return (
    <>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)", maxWidth: 720 }}>
        Build the <span style={{ color: "var(--fg-2)" }}>context-tree</span> — your team&apos;s shared knowledge that
        grows with your code.
      </p>

      <div style={{ marginTop: "var(--sp-5)", position: "relative" }}>
        <StepRailLine />

        <StepFrame number="01" state={selectedRepoUrl ? "complete" : "active"}>
          <RepoPickerSection
            disabled={busy}
            repos={repos}
            error={reposError}
            selectedRepoUrl={selectedRepoUrl}
            onSelect={setSelectedRepoUrl}
          />
        </StepFrame>

        <StepFrame number="02" state={treeModeChosen ? "complete" : selectedRepoUrl ? "active" : "idle"}>
          <h2
            className="text-subtitle font-semibold"
            style={{
              margin: 0,
              color: selectedRepoUrl ? "var(--fg)" : "var(--fg-4)",
              fontWeight: selectedRepoUrl ? 600 : 500,
            }}
          >
            Bind or create the tree
          </h2>
          {selectedRepoUrl ? (
            <div style={{ marginTop: "var(--sp-3)", display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
              {/* Segmented toggle — two-option choice as a single inline
                control instead of stacked radio cards. Real <input
                type="radio"> sit under the labels for screen readers; the
                visible "buttons" are styled labels. The conditional URL
                input below grows in only when "Bind to existing" is the
                active side, so the layout doesn't reserve dead space for
                the "Create new" path. */}
              <fieldset
                aria-label="Bind or create the tree"
                disabled={busy}
                style={{
                  display: "inline-flex",
                  alignSelf: "flex-start",
                  padding: "var(--sp-0_5)",
                  margin: 0,
                  background: "var(--surface-2)",
                  border: "var(--hairline) solid var(--border-faint)",
                  borderRadius: "var(--radius-input)",
                  gap: "var(--sp-0_5)",
                }}
              >
                <legend className="sr-only">Bind or create the tree</legend>
                {(
                  [
                    { value: "existing", label: "Bind to an existing tree" },
                    { value: "new", label: "Create a new tree" },
                  ] as const
                ).map((opt) => {
                  const active = treeMode === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className="text-body transition-colors"
                      style={{
                        padding: "var(--sp-1_5) var(--sp-3)",
                        background: active ? "var(--bg)" : "transparent",
                        borderRadius: "calc(var(--radius-input) - var(--sp-0_5))",
                        color: active ? "var(--fg)" : "var(--fg-3)",
                        fontWeight: active ? 600 : 400,
                        boxShadow: active ? "var(--shadow-sm)" : "none",
                        cursor: busy ? "not-allowed" : "pointer",
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="radio"
                        name="tree-mode"
                        value={opt.value}
                        checked={active}
                        onChange={() => setTreeMode(opt.value)}
                        className="sr-only"
                      />
                      {opt.label}
                    </label>
                  );
                })}
              </fieldset>

              {treeMode === "existing" ? (
                <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
                  <label htmlFor="onboarding-existing-tree-url" className="text-label" style={{ color: "var(--fg-3)" }}>
                    Tree GitHub URL
                  </label>
                  <input
                    id="onboarding-existing-tree-url"
                    type="url"
                    value={existingTreeUrl}
                    onChange={(e) => setExistingTreeUrl(e.target.value)}
                    placeholder="https://github.com/your-org/your-tree"
                    disabled={busy}
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
                </div>
              ) : null}

              {treeMode === "new" ? (
                <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
                  Your agent will scaffold a new GitHub repo for the tree and bind it to your source repo.
                </p>
              ) : null}
            </div>
          ) : null}
        </StepFrame>

        <StepFrame number="03" state={treeModeChosen ? "active" : "idle"}>
          <h2
            className="text-subtitle font-semibold"
            style={{
              margin: 0,
              color: treeModeChosen ? "var(--fg)" : "var(--fg-4)",
              fontWeight: treeModeChosen ? 600 : 500,
            }}
          >
            Let your agent build it
          </h2>
          {treeModeChosen ? (
            <>
              <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
                It&apos;ll install the skill, set up the tree, and open a PR back to your source repo.
              </p>

              {error ? (
                <div
                  className="text-body"
                  style={{
                    marginTop: "var(--sp-3)",
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

              <div className="flex" style={{ marginTop: "var(--sp-3)", gap: "var(--sp-2)" }}>
                <Button type="button" disabled={!canContinue} onClick={() => void handleContinue()}>
                  {busy ? "Starting…" : "Continue"}
                </Button>
                <Button type="button" variant="outline" onClick={handleLater} disabled={busy}>
                  I&apos;ll do it later
                </Button>
              </div>
            </>
          ) : null}
        </StepFrame>
      </div>
    </>
  );
}

// ─── Shared Step 2 visual primitives ─────────────────────────────────────

function RepoPickerSection({
  disabled,
  repos,
  error,
  selectedRepoUrl,
  onSelect,
}: {
  disabled: boolean;
  repos: GithubRepo[] | null;
  error: string | null;
  selectedRepoUrl: string | null;
  onSelect: (url: string | null) => void;
}) {
  const heading = (
    <h2
      className="text-subtitle font-semibold"
      style={{
        color: disabled ? "var(--fg-4)" : "var(--fg)",
        fontWeight: disabled ? 500 : 600,
      }}
    >
      Connect your source repo
    </h2>
  );

  if (disabled) {
    return <div>{heading}</div>;
  }

  if (error) {
    return (
      <div style={{ animation: "subtle-fade 200ms ease-out" }}>
        {heading}
        <p className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
          {error}. Reconnect your GitHub account to grant repo access.
        </p>
        <div style={{ marginTop: "var(--sp-2)" }}>
          <Button type="button" variant="outline" size="sm" asChild>
            <a href="/api/v1/auth/github/start?next=/">Reconnect GitHub</a>
          </Button>
        </div>
      </div>
    );
  }

  if (repos === null) {
    return (
      <div style={{ animation: "subtle-fade 200ms ease-out" }}>
        {heading}
        <p className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
          Loading your GitHub repositories…
        </p>
      </div>
    );
  }

  if (repos.length === 0) {
    return (
      <div style={{ animation: "subtle-fade 200ms ease-out" }}>
        {heading}
        <p className="text-label" style={{ color: "var(--fg-3)", marginTop: "var(--sp-2)" }}>
          No repositories found on your GitHub account. Create one and refresh this page.
        </p>
      </div>
    );
  }

  return (
    <div style={{ animation: "subtle-fade 200ms ease-out" }}>
      {heading}
      <p className="text-body" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
        The code your tree will organize knowledge about.
      </p>
      <select
        aria-label="GitHub repository"
        value={selectedRepoUrl ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
        className="text-body"
        style={{
          marginTop: "var(--sp-2)",
          width: "100%",
          padding: "var(--sp-2) var(--sp-3)",
          background: "var(--bg)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg)",
          outline: "none",
        }}
      >
        <option value="">Select a repository…</option>
        {repos.map((repo) => (
          <option key={repo.cloneUrl} value={repo.cloneUrl}>
            {repo.fullName}
            {repo.private ? " · private" : ""}
          </option>
        ))}
      </select>
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
