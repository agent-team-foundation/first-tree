import type { AgentVisibility } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAuth } from "../../../auth/auth-context.js";
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
    // Full-consequence disclosure: org-visible means teammates can start work
    // with this agent directly — on the owner's computer and plan. Kept in
    // sync with new-agent-dialog.tsx and profile-edit-dialog.tsx.
    description:
      "Anyone on your team can @mention it and start work with it — it runs on your computer and uses your plan.",
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
 * start-chat (the agent-online callback), so this renders form → creating →
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
    finishLater,
    agentPhase,
    agentError,
    goNext,
    goTo,
    sequence,
  } = useOnboardingFlow();
  const { currentOrgHasPersonalAgent } = useAuth();

  // Fresh onboarding entry always lands on the opening step and walks forward
  // (inferInitialStepIndex ignores server readiness), so a member who already
  // created their personal agent in this org — e.g. a refresh / new tab after
  // the agent came online but before start-chat — can reach this step again.
  // Creating here would make a duplicate agent, so skip straight past the form.
  // Gated on `idle` + the one-shot ref so it never double-advances the normal
  // create path, which advances itself via the flow's onAgentOnline -> goNext.
  const skippedExistingAgent = useRef(false);
  useEffect(() => {
    if (skippedExistingAgent.current) return;
    if (currentOrgHasPersonalAgent && agentPhase === "idle") {
      skippedExistingAgent.current = true;
      goNext();
    }
  }, [currentOrgHasPersonalAgent, agentPhase, goNext]);

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

  // Coding-agent pills to render. When the computer drops mid-form, okRuntimes
  // empties but `selectedRuntime` keeps the last pick — so we still show THAT
  // agent (disabled) rather than letting the whole field vanish and the form
  // jump. A disabled pill + the reconnect hint reads as "your agent's here, just
  // temporarily unreachable", not "it's gone".
  const connected = !!computer.connectedClient;
  const fallbackProvider = selectedRuntime ? asRuntimeProvider(selectedRuntime) : null;
  const displayProviders = okProviders.length > 0 ? okProviders : fallbackProvider ? [fallbackProvider] : [];

  if (agentPhase === "creating") {
    return <WorkingState label={COPY.createAgent.creating} hint={COPY.createAgent.creatingHint} />;
  }

  if (agentPhase === "timeout") {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
        {/* Slow-start, not a failure: the shell's step h1 already heads the screen,
            so one plain paragraph, then two paths — keep waiting (re-poll) or the
            graceful, resumable "finish later" so a genuinely-stuck runtime is never
            a dead end. */}
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          {COPY.createAgent.timeoutBody}
        </p>
        <div className="flex items-center" style={{ gap: "var(--sp-3)" }}>
          <Button type="button" onClick={() => void retryAgent()}>
            {COPY.createAgent.keepWaiting}
          </Button>
          <button
            type="button"
            className="text-label font-medium underline underline-offset-2"
            style={{ color: "var(--fg-3)" }}
            onClick={() => void finishLater()}
          >
            {COPY.finishLater}
          </button>
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

      {/* Coding agent — always a list (even for one), default Claude Code.
          Stays visible (disabled) when the computer drops, so the field never
          vanishes from under the user. */}
      {displayProviders.length > 0 && (
        <fieldset className="flex flex-col" style={{ gap: "var(--sp-2)", margin: 0, padding: 0, border: 0 }}>
          <legend
            className="text-label font-medium"
            style={{
              color: "var(--fg-2)",
              marginBottom: "var(--sp-1)",
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--sp-2)",
            }}
          >
            {COPY.createAgent.codingAgentLabel}
            {/* Prominent amber "Not ready" badge when the computer dropped — makes
                the disabled pill read as unavailable (reconnect needed), not just
                quietly greyed. */}
            {!connected && (
              <span
                className="inline-flex items-center text-caption font-medium"
                style={{
                  gap: "var(--sp-1)",
                  padding: "var(--sp-0_5) var(--sp-1_5)",
                  borderRadius: "var(--radius-chip)",
                  background: "var(--state-needs-you-soft)",
                  color: "var(--fg-needs-you-strong)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: "var(--sp-1_5)",
                    height: "var(--sp-1_5)",
                    borderRadius: "var(--radius-full)",
                    background: "var(--state-needs-you)",
                  }}
                />
                {COPY.createAgent.codingAgentNotReady}
              </span>
            )}
          </legend>
          <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
            {displayProviders.map((provider) => (
              <OptionCard
                key={provider}
                name="onboarding-coding-agent"
                layout="pill"
                checked={selectedRuntime === provider}
                onSelect={() => setSelectedRuntime(provider)}
                disabled={!connected}
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
