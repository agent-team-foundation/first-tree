import { ArrowRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { listManagedAgents } from "../../api/agents.js";
import { postOnboardingStartChat } from "../../api/onboarding-events.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useAgentCreation } from "../../features/agent-setup/use-agent-creation.js";
import { useComputerConnection } from "../../features/agent-setup/use-computer-connection.js";
import { runtimeProviderLabel } from "../clients/cards/shared/providers.js";
import { CommandBox, FlowHint, StatusRow, WorkingState } from "../onboarding/flow-ui.js";
import { getCampaign, QUICKSTART_AGENT_NAME } from "./campaigns.js";
import {
  type CampaignIntent,
  clearCampaignIntent,
  readCampaignHandoff,
  readCampaignIntent,
  readQuickstartAgent,
  writeCampaignIntent,
  writeQuickstartAgent,
} from "./intent.js";

/**
 * Reusable quickstart growth entry (`/quickstart?campaign=<slug>&repo=...`).
 *
 * After login the only thing the user does is connect a computer; once a
 * computer with a usable runtime is up, the flow runs to completion on its own:
 * auto-create a private "Cedar" agent on the preferred runtime, then start the
 * campaign's value-first first chat and drop the user into it. No buttons, no
 * runtime picker gate. The one branch that needs the user is "connected but no
 * coding agent installed", which leads to install links and resumes
 * automatically once a runtime appears.
 */
export function QuickstartPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { organizationId, refreshMe, currentOrgHasPersonalAgent } = useAuth();

  // Resolve the campaign handoff once. Prefer the URL — the landing CTA and the
  // post-login `next` round-trip land the params here — and persist it so a
  // same-tab re-entry survives; otherwise fall back to a stored intent.
  const intent = useMemo<CampaignIntent | null>(() => {
    const fromUrl = readCampaignHandoff(location);
    if (fromUrl) {
      writeCampaignIntent(fromUrl);
      return fromUrl;
    }
    return readCampaignIntent();
  }, [location]);
  const campaign = intent ? getCampaign(intent.campaign) : null;

  const computer = useComputerConnection(Boolean(intent && campaign));
  const setupStartedRef = useRef(false);
  const startChatStartedRef = useRef(false);
  const onlineAgentRef = useRef<{ uuid: string; displayName: string } | null>(null);
  const resumeStartedRef = useRef(false);
  // Read once on mount: an agent created in a prior attempt this tab (it
  // survives a remount). When present we resume with it rather than create a
  // duplicate.
  const stashedAgentUuid = useMemo(
    () => (intent ? readQuickstartAgent(intent.campaign, organizationId) : null),
    [intent, organizationId],
  );
  const [startChatError, setStartChatError] = useState<string | null>(null);

  const startChat = useCallback(
    async (agentUuid: string, agentDisplayName: string) => {
      if (!intent || !campaign || startChatStartedRef.current) return;
      onlineAgentRef.current = { uuid: agentUuid, displayName: agentDisplayName };
      startChatStartedRef.current = true;
      setStartChatError(null);
      try {
        const { chatId } = await postOnboardingStartChat({
          ...(organizationId ? { organizationId } : {}),
          agentUuid,
          bootstrap: campaign.buildBootstrap({ agentDisplayName, repoUrl: intent.url }),
          kind: "work",
          campaign: intent.campaign,
          complete: false,
        });
        // Consume the campaign so a later bare /quickstart visit in this tab
        // doesn't re-run it (clears the stored intent + the agent stash).
        clearCampaignIntent();
        // Refresh /me so the workspace's onboarding gate sees the just-created
        // agent + connected client. Without it the cached pre-flow /me still
        // reads "no personal agent", and the gate bounces a fresh user into
        // /onboarding instead of landing them in the chat.
        await refreshMe();
        navigate(`/?c=${encodeURIComponent(chatId)}`);
      } catch (err) {
        // Surface and let the user retry; do not loop (a failed start chat is
        // not auto-retried, only re-driven by the explicit Retry button).
        startChatStartedRef.current = false;
        setStartChatError(err instanceof Error ? err.message : "Couldn't open your chat. Please try again.");
      }
    },
    [intent, campaign, organizationId, navigate, refreshMe],
  );

  const {
    phase,
    error: agentError,
    create,
    retry: retryAgent,
  } = useAgentCreation({
    // Stash the created agent per-tab so a remount resumes with it. If the user
    // abandons before start chat, the agent isn't orphaned for long: a later
    // visit reuses it via setupAgent's (org, name) reuse path instead of
    // creating another.
    onCreated: (info) => {
      if (intent) writeQuickstartAgent({ campaign: intent.campaign, organizationId, uuid: info.agentUuid });
    },
    onOnline: (uuid) => void startChat(uuid, QUICKSTART_AGENT_NAME),
  });

  // Create a fresh private Cedar — only for a brand-new user with no agent yet.
  // (Edge: a *suspended* agent named "cedar" still holds the unique (org, name),
  // so a user whose only agent is a suspended cedar would 409 here — rare enough
  // to accept for v0, since the reuse path filters to active agents.)
  const createCedar = useCallback(() => {
    if (!computer.connectedClient || !computer.selectedRuntime) return;
    void create({
      displayName: QUICKSTART_AGENT_NAME,
      clientId: computer.connectedClient.id,
      runtimeProvider: computer.selectedRuntime,
      visibility: "private",
      organizationId,
    });
  }, [computer.connectedClient, computer.selectedRuntime, create, organizationId]);

  // Resolve-or-create the campaign agent: REUSE the user's existing personal
  // agent when they already have one (a second campaign after a successful
  // first, or a returning user). Creating another would hit the (org, name)
  // unique constraint — Cedar is the user's one long-term agent — so only a
  // brand-new user with no agent yet gets a fresh Cedar.
  const setupAgent = useCallback(async () => {
    if (currentOrgHasPersonalAgent) {
      try {
        const agents = await listManagedAgents();
        const usable = agents.filter(
          (a) =>
            a.type !== "human" && a.status === "active" && (!organizationId || a.organizationId === organizationId),
        );
        const clientId = computer.connectedClient?.id ?? null;
        // Prefer an agent already bound to the just-connected client (same
        // machine — it runs right here); otherwise the newest one. We reuse it
        // as-is and never move it: the server pins an agent's client immutably
        // (clientId is NULL -> ID only — see services/agent.ts updateAgent), so
        // a returning user on a *different* machine reuses their agent where it
        // already lives, which must be online to answer. Hosting the agent on
        // the newly connected machine (a true cross-machine move) is a
        // v0-accepted follow-up — it needs a server rebind path that does not
        // exist yet.
        const existing =
          (clientId ? usable.find((a) => a.clientId === clientId) : undefined) ??
          [...usable].sort((a, b) => b.uuid.localeCompare(a.uuid))[0];
        if (existing) {
          void startChat(existing.uuid, existing.displayName);
          return;
        }
      } catch {
        // Couldn't resolve the existing agent — fall through to create.
      }
    }
    createCedar();
  }, [currentOrgHasPersonalAgent, organizationId, startChat, createCedar, computer.connectedClient]);

  // Set up the agent once a computer is connected with a usable runtime — no
  // button, no picker. Fires once; skipped when an agent was already created
  // this attempt (remount) — the resume effect below handles that.
  useEffect(() => {
    if (setupStartedRef.current || stashedAgentUuid || !intent || !campaign) return;
    if (!computer.connectedClient || !computer.selectedRuntime || phase !== "idle") return;
    setupStartedRef.current = true;
    void setupAgent();
  }, [computer.connectedClient, computer.selectedRuntime, phase, intent, campaign, setupAgent, stashedAgentUuid]);

  // Remount after the agent was already created (refresh while waiting, or the
  // timeout/error screen): reuse the stashed agent and resume start chat.
  useEffect(() => {
    if (resumeStartedRef.current || !stashedAgentUuid || !intent || !campaign) return;
    resumeStartedRef.current = true;
    void startChat(stashedAgentUuid, QUICKSTART_AGENT_NAME);
  }, [stashedAgentUuid, intent, campaign, startChat]);

  const retryStartChat = useCallback(() => {
    const a = onlineAgentRef.current;
    if (a) void startChat(a.uuid, a.displayName);
  }, [startChat]);

  const retryAgentSetup = useCallback(() => {
    // Timeout = the agent was created but didn't come online in time → re-poll.
    // Otherwise setup failed → re-run resolve-or-create directly.
    if (phase === "timeout") {
      void retryAgent();
      return;
    }
    void setupAgent();
  }, [phase, retryAgent, setupAgent]);

  if (!intent || !campaign) {
    return (
      <QuickstartShell>
        <h1 className="text-title" style={{ margin: 0 }}>
          Start from a First Tree scan
        </h1>
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          Open this from a First Tree scan link so we know which repo to look at.
        </p>
        <div className="flex">
          <Button asChild>
            <a href="/">Go to your workspace</a>
          </Button>
        </div>
      </QuickstartShell>
    );
  }

  const connected = Boolean(computer.connectedClient);
  const noRuntime = connected && computer.capabilitiesLoaded && computer.okRuntimes.length === 0;
  const hostname = computer.connectedClient?.hostname ?? "your computer";

  return (
    <QuickstartShell repoSlug={intent.repoSlug}>
      <h1 className="text-title" style={{ margin: 0 }}>
        {connected ? "Setting things up…" : "Let's set up your scan"}
      </h1>

      {!connected ? (
        <ConnectStep cliCommand={computer.cliCommand} tokenError={computer.tokenError} onRetry={computer.retry} />
      ) : !computer.capabilitiesLoaded ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <StatusRow
            state="ok"
            label={
              <>
                <span className="mono font-semibold">{hostname}</span> connected
              </>
            }
          />
          <StatusRow state="waiting" label="Checking your computer…" />
        </div>
      ) : noRuntime ? (
        <NoRuntimeStep hostname={hostname} />
      ) : startChatError ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <StatusRow state="ok" label={<RuntimeStatus hostname={hostname} runtime={computer.selectedRuntime} />} />
          <FlowHint tone="error" role="alert">
            {startChatError}
          </FlowHint>
          <div className="flex">
            <Button type="button" onClick={retryStartChat}>
              <span>Try again</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : phase === "timeout" || agentError ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <StatusRow state="ok" label={<RuntimeStatus hostname={hostname} runtime={computer.selectedRuntime} />} />
          <FlowHint tone="error" role="alert">
            {agentError ?? `Setting up ${QUICKSTART_AGENT_NAME} is taking longer than expected.`}
          </FlowHint>
          <div className="flex">
            <Button type="button" onClick={retryAgentSetup}>
              <span>Try again</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <StatusRow state="ok" label={<RuntimeStatus hostname={hostname} runtime={computer.selectedRuntime} />} />
          <WorkingState
            label={`Setting up ${QUICKSTART_AGENT_NAME}…`}
            hint="Creating your private agent and opening your first chat."
          />
          {computer.okRuntimes.length > 1 && computer.selectedRuntime ? (
            <p className="text-label" style={{ margin: 0, textAlign: "center", color: "var(--fg-4)" }}>
              Running on {runtimeProviderLabel(computer.selectedRuntime)} — switch in {QUICKSTART_AGENT_NAME}'s settings
              anytime.
            </p>
          ) : null}
        </div>
      )}
    </QuickstartShell>
  );
}

function RuntimeStatus({ hostname, runtime }: { hostname: string; runtime: string | null }) {
  return (
    <>
      <span className="mono font-semibold">{hostname}</span> connected
      {runtime ? ` · ${runtimeProviderLabel(runtime)}` : ""}
    </>
  );
}

function ConnectStep({
  cliCommand,
  tokenError,
  onRetry,
}: {
  cliCommand: string | null;
  tokenError: string | null;
  onRetry: () => void;
}) {
  if (tokenError) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          First Tree runs on your own computer, so your code stays local.
        </p>
        <FlowHint tone="error" role="alert">
          {tokenError}
        </FlowHint>
        <div className="flex">
          <Button type="button" onClick={onRetry}>
            <span>Try again</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        First Tree runs on your own computer, so your code stays local. Connect it once — everything after is automatic.
      </p>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
          RUN THIS IN YOUR TERMINAL
        </p>
        <CommandBox command={cliCommand} />
      </div>
      <StatusRow state="waiting" label="Waiting for your computer to connect…" />
    </>
  );
}

function NoRuntimeStep({ hostname }: { hostname: string }) {
  return (
    <>
      <StatusRow
        state="ok"
        label={
          <>
            <span className="mono font-semibold">{hostname}</span> connected
          </>
        }
      />
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        First Tree runs your agent on a coding agent installed on your computer. We didn't find Claude Code or Codex on
        this one — install either and setup finishes on its own.
      </p>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <a
          className="text-body font-medium"
          href="https://www.anthropic.com/claude-code"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--fg)" }}
        >
          Install Claude Code →
        </a>
        <a
          className="text-body font-medium"
          href="https://openai.com/codex"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--fg)" }}
        >
          Install Codex →
        </a>
      </div>
      <StatusRow state="waiting" label="We'll detect it and finish automatically — no need to come back here." />
    </>
  );
}

function QuickstartShell({ repoSlug, children }: { repoSlug?: string; children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center"
      style={{ background: "var(--bg)", color: "var(--fg)", padding: "var(--sp-8) var(--sp-5)" }}
    >
      <div className="flex w-full flex-col" style={{ maxWidth: "30rem", gap: "var(--sp-5)" }}>
        <div className="inline-flex items-center text-label" style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}>
          <span
            aria-hidden="true"
            style={{
              width: "var(--sp-2_5)",
              height: "var(--sp-2_5)",
              borderRadius: "var(--radius-full)",
              background: "var(--brand)",
            }}
          />
          First Tree
        </div>
        {repoSlug ? (
          <span
            className="inline-flex items-center text-label"
            style={{
              alignSelf: "flex-start",
              gap: "var(--sp-1_5)",
              padding: "var(--sp-1) var(--sp-2_5)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-full)",
              color: "var(--fg-2)",
            }}
          >
            {repoSlug}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}
