import type { AgentVisibility } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { FlowNote, WorkingState } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

const VISIBILITY_OPTIONS: ReadonlyArray<{ value: AgentVisibility; title: string; description: string }> = [
  {
    value: "organization",
    title: "Shared with team",
    description: "Anyone on your team can talk to this AI teammate.",
  },
  {
    value: "private",
    title: "Just me",
    description: "Only you can see and talk to this AI teammate.",
  },
];

/**
 * Name the AI teammate and choose who can use it. The computer + runtime
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
        <FlowNote tone="info">{COPY.createAgent.timeoutBody}</FlowNote>
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
        <input
          id="onboarding-agent-name"
          aria-label="AI teammate name"
          value={agentDisplayName}
          onChange={(e) => setAgentDisplayName(e.target.value)}
          placeholder="e.g. Buddy, Helper"
          maxLength={200}
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
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--accent)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        />
      </div>

      <fieldset className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-medium" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-1)" }}>
          Who can use it?
        </legend>
        {VISIBILITY_OPTIONS.map((opt) => {
          const active = visibility === opt.value;
          return (
            <label
              key={opt.value}
              className="onboarding-choice flex items-start text-body"
              style={{
                gap: "var(--sp-2)",
                padding: "var(--sp-2) var(--sp-3)",
                background: active ? "color-mix(in oklch, var(--accent) 8%, var(--bg))" : "var(--bg)",
                border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-faint)",
                borderRadius: "var(--radius-input)",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="onboarding-visibility"
                value={opt.value}
                checked={active}
                onChange={() => setVisibility(opt.value)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className="inline-flex items-center justify-center"
                style={{
                  width: "var(--sp-3_5)",
                  height: "var(--sp-3_5)",
                  marginTop: "var(--sp-0_5)",
                  flexShrink: 0,
                  borderRadius: "50%",
                  border: active ? "var(--hairline) solid var(--accent)" : "var(--hairline) solid var(--border-strong)",
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

      {agentError && <FlowNote>{COPY.errors.agentFailed}</FlowNote>}

      <div className="flex">
        <Button type="button" onClick={handleCreate} disabled={!canCreate}>
          <span>Create {trimmed || "your AI teammate"}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
