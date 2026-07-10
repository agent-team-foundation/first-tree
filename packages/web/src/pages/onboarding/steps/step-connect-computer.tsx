import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { runtimeProviderLabel } from "../../clients/cards/shared/providers.js";
import { COPY } from "../copy.js";
import { CommandBox, FlowHint, StatusRow } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Install the First Tree client (a small background app) on the user's computer.
 * Two install paths: run the command block in a terminal, OR paste a ready prompt to
 * the coding agent the user already has (Claude Code / Codex) and let it install.
 * We poll until the computer shows up, then list the coding agents detected on it
 * (read-only — picking which one to use moves to the next step, create-agent).
 *
 * No "Need help?" disclosure / example terminal: the normal state is just the
 * server-provided command(s) + status.
 */
export function StepConnectComputer() {
  const { computer, goNext } = useOnboardingFlow();
  const { connectedClient, capabilitiesLoaded, okRuntimes, cliCommand, tokenError, retry } = computer;

  const noRuntime = !!connectedClient && capabilitiesLoaded && okRuntimes.length === 0;
  const ready = !!connectedClient && okRuntimes.length > 0;

  // Box 2 hands the SAME command to the user's coding agent as a paste-able
  // prompt, with a natural-language "please run this" wrapper so the agent
  // actually executes it (a bare command pasted in might only get explained).
  const agentPrompt = cliCommand ? `${COPY.connectComputer.agentPromptPrefix}\n${cliCommand}` : null;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        {connectedClient ? COPY.connectComputer.whyConnected : COPY.connectComputer.whyWaiting}
      </p>

      {!connectedClient ? (
        tokenError ? (
          // Just the message — the retry action rides on the step's primary
          // bottom button (which becomes "Try again" in this state), so there's
          // no separate retry button + a dead disabled "Continue".
          <FlowHint tone="error" role="alert">
            {COPY.connectComputer.tokenErrorTitle}
          </FlowHint>
        ) : (
          <>
            {/* Path 1 — run it yourself in a terminal (bare command). */}
            <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
                {COPY.connectComputer.terminalBoxLabel}
              </p>
              <CommandBox command={cliCommand} />
            </div>
            {/* Path 2 — paste a ready prompt to the coding agent you already
                  have; the "please run this" wrapper makes the agent execute it. */}
            <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
                {COPY.connectComputer.agentBoxLabel}
              </p>
              <CommandBox command={agentPrompt} />
            </div>
            <StatusRow state="waiting" label={COPY.connectComputer.waiting} />
          </>
        )
      ) : (
        <>
          <StatusRow
            state="ok"
            label={
              <>
                <span className="mono font-semibold">{connectedClient.hostname ?? connectedClient.id}</span>{" "}
                {COPY.connectComputer.connected}
              </>
            }
          />
          {!capabilitiesLoaded ? (
            <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
              {COPY.connectComputer.detecting}
            </p>
          ) : noRuntime ? (
            <FlowHint>{COPY.connectComputer.noRuntime}</FlowHint>
          ) : (
            // Detected coding agents — a READ-ONLY list (name + status). Choosing
            // which one to use is the next step (create-agent), not here. The
            // list is nested UNDER the connected-computer row (indented behind a
            // containment rail, with quieter dot markers) so it reads as "found
            // ON this machine" rather than as peers of the computer above — the
            // bold green check stays the computer's alone.
            <div className="flex flex-col" style={{ gap: "var(--sp-2_5)" }}>
              <div
                className="flex flex-col"
                style={{
                  gap: "var(--sp-2)",
                  // Align the rail under the computer row's check glyph so the
                  // indent reads as containment, not an arbitrary offset.
                  marginLeft: "var(--sp-1_5)",
                  paddingLeft: "var(--sp-3)",
                  borderLeft: "var(--hairline) solid var(--border)",
                }}
              >
                {/* Names the nested group so the relationship is stated, not
                    only implied by the indent. */}
                <p className="text-caption" style={{ margin: 0, color: "var(--fg-4)" }}>
                  {COPY.connectComputer.detectedLabel(okRuntimes.length)}
                </p>
                <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
                  {okRuntimes.map((r) => (
                    <div
                      key={r}
                      className="inline-flex items-center text-label"
                      role="status"
                      style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: "var(--sp-1_5)",
                          height: "var(--sp-1_5)",
                          flexShrink: 0,
                          borderRadius: "var(--radius-full)",
                          background: "var(--success)",
                        }}
                      />
                      <span className="font-medium" style={{ color: "var(--fg)" }}>
                        {runtimeProviderLabel(r)}
                      </span>
                      <span style={{ color: "var(--success)" }}>· ready</span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
                {COPY.connectComputer.detectedBridge}
              </p>
            </div>
          )}
        </>
      )}

      <div className="flex">
        {tokenError && !connectedClient ? (
          // Token mint failed: the only useful action is retry, so the primary
          // button itself becomes "Try again" rather than sitting disabled
          // beside a separate retry button.
          <Button type="button" onClick={retry}>
            <span>{COPY.connectComputer.retry}</span>
          </Button>
        ) : (
          <Button type="button" onClick={goNext} disabled={!ready}>
            <span>{COPY.continue}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
