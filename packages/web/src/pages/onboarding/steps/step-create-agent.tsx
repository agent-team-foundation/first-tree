import type { AgentVisibility } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { OptionCard } from "../../../components/ui/option-card.js";
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
  } = useOnboardingFlow();

  const trimmed = agentDisplayName.trim();
  const canCreate =
    !!trimmed &&
    !!computer.connectedClient &&
    !!computer.selectedRuntime &&
    computer.okRuntimes.includes(computer.selectedRuntime) &&
    agentPhase === "idle";

  if (agentPhase === "creating") {
    return <WorkingState label={COPY.createAgent.creating} hint={COPY.createAgent.creatingHint} />;
  }

  if (agentPhase === "timeout") {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        <p className="text-subtitle font-semibold" style={{ color: "var(--fg)" }}>
          {COPY.createAgent.timeoutTitle}
        </p>
        {/* Light treatment (consistent with the connect-computer states): the
            heading already signals the problem, so the body is a plain line,
            not a saturated callout box. */}
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

      <div className="flex">
        <Button type="button" variant="cta" onClick={handleCreate} disabled={!canCreate}>
          <span>Create {trimmed || "your agent"}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
