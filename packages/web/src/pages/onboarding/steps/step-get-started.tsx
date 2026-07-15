import type { Agent } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { listMembers } from "../../../api/members.js";
import { useAuth } from "../../../auth/auth-context.js";
import { Avatar } from "../../../components/avatar.js";
import { Button } from "../../../components/ui/button.js";
import { useOrgAgents } from "../../../lib/use-org-agents.js";
import { buildTeamAgentStartBootstrap } from "../../workspace/center/onboarding/bootstrap-prose.js";
import { COPY } from "../copy.js";
import { FlowHint, StatusRow, StepHeading, WorkingState } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";
import { startChatErrorMessage } from "../provision-tree.js";
import { canOfferTeamAgentStart } from "../steps.js";
import { startOnboardingChat } from "../tree-setup-chat.js";

/**
 * Invitee fork (`get-started`): after joining a team that already runs
 * org-visible agents, choose between the standard setup (connect a computer,
 * create your own agent — the primary choice) and an install-free quick start
 * in a team agent's chat.
 *
 * The quick start reuses the ordinary kickoff pipeline (`startOnboardingChat`
 * → POST /me/onboarding/kickoff): same per-(human, agent) idempotency key,
 * same dual-reader bootstrap that wakes the agent. The only differences are
 * the target (a teammate's org-visible agent instead of one the member
 * created) and the stamp (`invitee_skip` — suppress onboarding auto-open,
 * never completion, so the standard journey stays resumable from Settings →
 * Setup).
 *
 * Self-skipping: when `canOfferTeamAgentStart` is false (no shareable team
 * agent, or the member already has their own) the step advances immediately,
 * so the standard invitee journey is unchanged and the admin path never
 * contains this step at all.
 */
export function StepGetStarted() {
  const { goNext } = useOnboardingFlow();
  const { currentOrgHasUsableAgent, currentOrgHasPersonalAgent } = useAuth();
  const offer = canOfferTeamAgentStart({ currentOrgHasUsableAgent, currentOrgHasPersonalAgent });
  const [mode, setMode] = useState<"choose" | "pick">("choose");

  useEffect(() => {
    if (!offer) goNext();
  }, [offer, goNext]);
  if (!offer) return null;

  return mode === "choose" ? (
    <ChooseStart onOwnAgent={goNext} onQuickStart={() => setMode("pick")} />
  ) : (
    <PickTeamAgent onBack={() => setMode("choose")} onContinueSetup={goNext} />
  );
}

// ── choose: own agent vs quick start ────────────────────────────────────

function ChooseStart({ onOwnAgent, onQuickStart }: { onOwnAgent: () => void; onQuickStart: () => void }) {
  const g = COPY.getStarted;
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <StepHeading title={g.chooseTitle} why={g.chooseWhy} />
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <ChoiceCard primary title={g.own.title} description={g.own.description} cta={g.own.cta} onSelect={onOwnAgent} />
        <ChoiceCard title={g.quick.title} description={g.quick.description} cta={g.quick.cta} onSelect={onQuickStart} />
      </div>
    </div>
  );
}

/**
 * A full-card action (not an OptionCard: there is no radio state — clicking
 * IS the decision). The primary card carries the stronger border so "set up
 * my own agent" reads as the default; the quick start is a parallel choice,
 * not an escape hatch.
 */
function ChoiceCard({
  title,
  description,
  cta,
  onSelect,
  primary = false,
}: {
  title: string;
  description: string;
  cta: string;
  onSelect: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="text-left transition-colors hover:bg-accent/50"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--sp-1)",
        padding: "var(--sp-4) var(--sp-5)",
        borderRadius: "var(--radius-input)",
        border: primary ? "var(--hairline) solid var(--fg)" : "var(--hairline) solid var(--border)",
        background: "transparent",
        cursor: "pointer",
      }}
    >
      <span className="text-body font-semibold" style={{ color: "var(--fg)" }}>
        {title}
      </span>
      <span className="text-label" style={{ color: "var(--fg-3)" }}>
        {description}
      </span>
      <span
        className="text-label font-medium inline-flex items-center"
        style={{ gap: "var(--sp-1)", color: "var(--fg)", marginTop: "var(--sp-2)" }}
      >
        {cta}
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

// ── pick: choose a team agent and start the kickoff chat ────────────────

function PickTeamAgent({ onBack, onContinueSetup }: { onBack: () => void; onContinueSetup: () => void }) {
  const g = COPY.getStarted;
  const { organizationId, memberId, skipAndEnterChat } = useOnboardingFlow();
  const [phase, setPhase] = useState<"idle" | "starting">("idle");
  const [error, setError] = useState<string | null>(null);

  // Same visibility surface as the chat participant pickers: org-visible
  // active agents. `addressableOnly` excludes suspended agents, landing-trial
  // agents, and inactive human mirrors server-side.
  const agentsQuery = useOrgAgents({ addressableOnly: true });
  // Owner names for the "Run by X" tag. Member-readable route; cheap and
  // rarely-changing, so no polling.
  const membersQuery = useQuery({ queryKey: ["members"], queryFn: listMembers, staleTime: 60_000 });

  const ownerById = new Map((membersQuery.data ?? []).map((m) => [m.id, m.displayName]));
  // Non-human teammates only; exclude anything the member manages themselves
  // (defensive — the fork self-skips once they have a personal agent).
  const candidates = (agentsQuery.data?.items ?? []).filter(
    (a) => a.type !== "human" && !(memberId && a.managerId === memberId),
  );

  const handleStart = async (agent: Agent): Promise<void> => {
    setError(null);
    setPhase("starting");
    try {
      const chatId = await startOnboardingChat({
        agent,
        bootstrap: buildTeamAgentStartBootstrap(agent.displayName),
        organizationId,
        topic: "Get settled on First Tree",
        treeBindingPlan: "none",
        joinPath: "invite",
        // Suppress onboarding auto-open only — never completion. The member's
        // own connect-computer → create-agent journey stays pending.
        stamp: "invitee_skip",
        startChatType: "team-agent-quick-start",
      });
      await skipAndEnterChat(chatId);
    } catch (err) {
      setError(startChatErrorMessage(err, COPY.errors.chatFailed));
      setPhase("idle");
    }
  };

  if (phase === "starting") return <WorkingState label={COPY.startChat.starting} />;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <div className="flex">
        <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>{COPY.back}</span>
        </Button>
      </div>
      <StepHeading title={g.pickTitle} why={g.pickWhy} />
      {error && (
        <FlowHint tone="error" role="alert">
          {error}
        </FlowHint>
      )}
      {agentsQuery.isLoading ? (
        <StatusRow state="waiting" label="Loading team agents…" />
      ) : candidates.length === 0 ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <FlowHint>{g.pickEmpty}</FlowHint>
          <div className="flex">
            <Button type="button" onClick={onContinueSetup}>
              <span>{COPY.getStarted.own.cta}</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {candidates.map((a, i) => (
            <AgentRow
              key={a.uuid}
              agent={a}
              owner={a.managerId ? (ownerById.get(a.managerId) ?? null) : null}
              first={i === 0}
              onStart={() => void handleStart(a)}
            />
          ))}
        </div>
      )}
      <p className="text-caption" style={{ margin: 0, color: "var(--fg-4)" }}>
        {g.pickFootnote}
      </p>
    </div>
  );
}

function AgentRow({
  agent,
  owner,
  first,
  onStart,
}: {
  agent: Agent;
  owner: string | null;
  first: boolean;
  onStart: () => void;
}) {
  const g = COPY.getStarted;
  const detail: ReactNode = [agent.name ? `@${agent.name}` : null, owner ? g.runBy(owner) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="flex items-center"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-3) 0",
        borderTop: first ? "none" : "var(--hairline) solid var(--border)",
      }}
    >
      <Avatar
        name={agent.displayName}
        src={agent.avatarImageUrl}
        colorToken={agent.avatarColorToken}
        seed={agent.uuid}
        size={28}
      />
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium truncate" style={{ color: "var(--fg)" }}>
          {agent.displayName}
        </div>
        {detail ? (
          <div className="text-caption truncate" style={{ color: "var(--fg-4)" }}>
            {detail}
          </div>
        ) : null}
      </div>
      <Button type="button" onClick={onStart} className="shrink-0">
        {g.startChat}
      </Button>
    </div>
  );
}
