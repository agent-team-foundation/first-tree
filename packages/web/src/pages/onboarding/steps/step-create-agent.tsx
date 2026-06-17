import type { AgentVisibility } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { useEffect } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { OptionCard } from "../../../components/ui/option-card.js";
import { asRuntimeProvider, PROVIDER_LABEL } from "../../clients/cards/shared/providers.js";
import { COPY } from "../copy.js";
import { FlowHint, WorkingState } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

// Copy mirrors the New Agent dialog's Visibility block so the two
// agent-creation surfaces read identically (see new-agent-dialog.tsx).
const VISIBILITY_OPTIONS: ReadonlyArray<{ value: AgentVisibility; title: string; description: string }> = [
  {
    value: "organization",
    title: "Visible to your team",
    description: "Anyone on your team can @mention and chat with it.",
  },
  {
    value: "private",
    title: "Private to you",
    description: "Only you can see and chat with it.",
  },
];

/**
 * Name the agent and choose who can use it. The computer + runtime
 * were settled in the previous step; we read them off the flow and never
 * surface "runtime" / "client" here. On success the flow auto-advances to
 * kickoff (the agent-online callback), so this renders form → creating →
 * (timeout fallback) only.
 */
export function StepCreateAgent() {
  const {
    agentDisplayName,
    setAgentDisplayName,
    visibility,
    setVisibility,
    computer,
    organizationId,
    createAgent,
    retryAgent,
    agentPhase,
    agentError,
    goTo,
    sequence,
  } = useOnboardingFlow();

  const trimmed = agentDisplayName.trim();
  const canCreate =
    !!trimmed &&
    !!computer.connectedClient &&
    !!computer.selectedRuntime &&
    computer.okRuntimes.includes(computer.selectedRuntime) &&
    agentPhase === "idle";

  // The coding-agent picker lives HERE now (moved from connect-computer). Always
  // a list — even for one — defaulting to Claude Code when present, else the
  // first detected. Seed the selection if it isn't a valid detected runtime yet.
  const { okRuntimes, selectedRuntime, setSelectedRuntime } = computer;
  useEffect(() => {
    if (selectedRuntime && okRuntimes.includes(selectedRuntime)) return;
    const next = okRuntimes.find((r) => r === "claude-code") ?? okRuntimes[0];
    if (next) setSelectedRuntime(next);
  }, [okRuntimes, selectedRuntime, setSelectedRuntime]);
  const okProviders = okRuntimes.flatMap((p) => {
    const provider = asRuntimeProvider(p);
    return provider ? [provider] : [];
  });

  if (agentPhase === "creating") {
    return <WorkingState label={COPY.createAgent.creating} hint={COPY.createAgent.creatingHint} />;
  }

  if (agentPhase === "timeout") {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {/* One plain paragraph — the shell's step h1 ("Add your agent to the team")
            already heads the screen, so no second bold title here — then retry. */}
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {COPY.createAgent.timeoutBody}
        </p>
        <div className="flex">
          <Button type="button" onClick={() => void retryAgent()}>
            {COPY.createAgent.retry}
          </Button>
        </div>
      </div>
    );
  }

  const handleCreate = (): void => {
    if (!canCreate || !computer.connectedClient || !computer.selectedRuntime) return;
    void createAgent({
      displayName: trimmed,
      clientId: computer.connectedClient.id,
      runtimeProvider: computer.selectedRuntime,
      visibility,
      organizationId,
    });
  };

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      {/* Collapsed-model subtitle: the agent you create IS your local coding
          agent given a team identity — no two-layer "powered by" framing. */}
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        {COPY.createAgent.subtitle}
      </p>

      {/* Coding agent — always a list (even for one), default Claude Code. */}
      {okProviders.length > 0 && (
        <fieldset className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0, border: 0 }}>
          <legend className="text-label font-medium" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
            {COPY.createAgent.codingAgentLabel}
          </legend>
          <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
            {okProviders.map((provider) => (
              <OptionCard
                key={provider}
                name="onboarding-coding-agent"
                layout="pill"
                checked={selectedRuntime === provider}
                onSelect={() => setSelectedRuntime(provider)}
              >
                <span className="text-body">{PROVIDER_LABEL[provider]}</span>
              </OptionCard>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="onboarding-agent-name" className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
          {COPY.createAgent.nameLabel}
        </label>
        <Input
          id="onboarding-agent-name"
          value={agentDisplayName}
          onChange={(e) => setAgentDisplayName(e.target.value)}
          placeholder="e.g. Buddy, Helper"
          maxLength={200}
        />
      </div>

      <fieldset className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-medium" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
          Who can use it?
        </legend>
        {/* Reuses the dialog's OptionCard so the selection visual matches
            exactly: same faint border selected/unselected, a neutral filled
            dot + light tint for the active choice — no near-black border. */}
        {VISIBILITY_OPTIONS.map((opt) => (
          <OptionCard
            key={opt.value}
            name="onboarding-visibility"
            checked={visibility === opt.value}
            onSelect={() => setVisibility(opt.value)}
          >
            <div className="min-w-0">
              <div className="text-body font-medium">{opt.title}</div>
              <div className="text-caption text-muted-foreground">{opt.description}</div>
            </div>
          </OptionCard>
        ))}
      </fieldset>

      {agentError && (
        // Light inline error; the Create button right below is the retry.
        <FlowHint tone="error" role="alert">
          {COPY.errors.agentFailed}
        </FlowHint>
      )}

      {!computer.connectedClient && (
        // Computer dropped (slept / offline) or resumed here with it not
        // connected — Create is gated on a live client. One line with the
        // "reconnect it" action inline (→ connect-computer), not a separate
        // orphaned link. Auto-clears once the poll sees it reconnect.
        <FlowHint>
          {COPY.createAgent.computerDisconnected.pre}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            style={{ color: "var(--primary)" }}
            onClick={() => goTo(sequence.indexOf("connect-computer"))}
          >
            {COPY.createAgent.computerDisconnected.link}
          </button>
          {COPY.createAgent.computerDisconnected.post}
        </FlowHint>
      )}

      <div className="flex">
        <Button type="button" variant="cta" onClick={handleCreate} disabled={!canCreate}>
          <span>Create agent</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
