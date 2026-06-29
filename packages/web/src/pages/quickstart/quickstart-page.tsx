import { ArrowRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { postOnboardingStartChat } from "../../api/onboarding-events.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useAgentCreation } from "../../features/agent-setup/use-agent-creation.js";
import { useComputerConnection } from "../../features/agent-setup/use-computer-connection.js";
import { runtimeProviderLabel } from "../clients/cards/shared/providers.js";
import { CommandBox, FlowHint, StatusRow, WorkingState } from "../onboarding/flow-ui.js";
import { getCampaign, QUICKSTART_AGENT_NAME } from "./campaigns.js";
import { type CampaignIntent, readCampaignHandoff, readCampaignIntent, writeCampaignIntent } from "./intent.js";

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
  const { organizationId } = useAuth();

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
  const createStartedRef = useRef(false);
  const startChatStartedRef = useRef(false);
  const onlineAgentRef = useRef<string | null>(null);
  const [startChatError, setStartChatError] = useState<string | null>(null);

  const startChat = useCallback(
    async (agentUuid: string) => {
      onlineAgentRef.current = agentUuid;
      if (!intent || !campaign || startChatStartedRef.current) return;
      startChatStartedRef.current = true;
      setStartChatError(null);
      try {
        const { chatId } = await postOnboardingStartChat({
          ...(organizationId ? { organizationId } : {}),
          agentUuid,
          bootstrap: campaign.buildBootstrap({ agentDisplayName: QUICKSTART_AGENT_NAME, repoUrl: intent.url }),
          kind: "work",
          campaign: intent.campaign,
          complete: false,
        });
        navigate(`/?c=${encodeURIComponent(chatId)}`);
      } catch (err) {
        // Surface and let the user retry; do not loop (a failed start chat is
        // not auto-retried, only re-driven by the explicit Retry button).
        startChatStartedRef.current = false;
        setStartChatError(err instanceof Error ? err.message : "Couldn't open your chat. Please try again.");
      }
    },
    [intent, campaign, organizationId, navigate],
  );

  const { phase, create } = useAgentCreation({ onOnline: startChat });

  // Auto-create Cedar the moment a computer is connected with a usable runtime —
  // no button, no picker (the runtime auto-resolves, Claude Code preferred). The
  // ref makes this fire exactly once even though the mocked/real `create` and
  // `phase` may not change between renders.
  useEffect(() => {
    if (createStartedRef.current || !intent) return;
    if (!computer.connectedClient || !computer.selectedRuntime || phase !== "idle") return;
    createStartedRef.current = true;
    void create({
      displayName: QUICKSTART_AGENT_NAME,
      clientId: computer.connectedClient.id,
      runtimeProvider: computer.selectedRuntime,
      visibility: "private",
      organizationId,
    });
  }, [computer.connectedClient, computer.selectedRuntime, phase, intent, create, organizationId]);

  const retryStartChat = useCallback(() => {
    if (onlineAgentRef.current) void startChat(onlineAgentRef.current);
  }, [startChat]);

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
        <ConnectStep cliCommand={computer.cliCommand} />
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
              <span>Retry</span>
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

function ConnectStep({ cliCommand }: { cliCommand: string | null }) {
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
