import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { CommandBox, FlowNote, StatusRow } from "../flow-ui.js";
import { ShowMeHow, TerminalGuide } from "../guides.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

// How long to wait on the command before surfacing the "stuck?" panel. The
// happy path is seconds; this only fires for the true-beginner wall (no
// Node, wrong machine, firewall). We keep polling underneath, so it still
// auto-advances the moment the computer connects.
const STUCK_AFTER_MS = 75_000;

/**
 * Connect the computer the AI teammate will run on. The user pastes a
 * one-liner into a terminal; we poll until the computer shows up and confirm
 * an AI engine is ready on it. No "runtime"/"terminal-jockey" assumptions —
 * if it stalls we surface plain-language recovery (the #1 cause is "npm not
 * installed"), and if no engine is ready we say so and link the install.
 */
export function StepConnectComputer() {
  const { computer, goNext } = useOnboardingFlow();
  const { connectedClient, capabilitiesLoaded, okRuntimes, cliCommand, tokenError } = computer;

  const noRuntime = !!connectedClient && capabilitiesLoaded && okRuntimes.length === 0;
  const ready = !!connectedClient && okRuntimes.length > 0;

  // Surface help if the command doesn't connect within a reasonable window.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (connectedClient) {
      setStuck(false);
      return;
    }
    const t = window.setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [connectedClient]);

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      {!connectedClient ? (
        <>
          <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
            {COPY.connectComputer.instruction}
          </p>
          <CommandBox command={cliCommand} />
          {tokenError ? (
            <FlowNote>{tokenError}</FlowNote>
          ) : (
            <StatusRow state="waiting" label={COPY.connectComputer.waiting} />
          )}
          {stuck && <StuckPanel />}
          <ShowMeHow>
            <TerminalGuide />
          </ShowMeHow>
        </>
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
            <FlowNote tone="info">{COPY.connectComputer.noRuntime}</FlowNote>
          ) : null}
        </>
      )}

      <div className="flex">
        <Button type="button" onClick={goNext} disabled={!ready}>
          <span>{COPY.continue}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function StuckPanel() {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-3)",
        borderRadius: "var(--radius-input)",
        background: "color-mix(in oklch, var(--bg-raised) 40%, transparent)",
        border: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
        {COPY.connectComputer.stuckTitle}
      </p>
      <ul className="flex flex-col" style={{ gap: "var(--sp-1_5)", margin: 0, paddingLeft: "var(--sp-4)" }}>
        {COPY.connectComputer.stuckReasons.map((reason) => (
          <li key={reason} className="text-label" style={{ color: "var(--fg-3)" }}>
            {reason}
          </li>
        ))}
      </ul>
      <a
        href={COPY.connectComputer.nodeUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-label font-medium self-start"
        style={{ color: "var(--accent)" }}
      >
        {COPY.connectComputer.nodeLinkLabel} →
      </a>
    </div>
  );
}
