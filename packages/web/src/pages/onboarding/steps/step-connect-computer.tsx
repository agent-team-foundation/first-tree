import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { ConnectStuckPanel, STUCK_AFTER_MS } from "../../../components/connect-stuck-panel.js";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { CommandBox, FlowNote, StatusRow } from "../flow-ui.js";
import { ShowMeHow, TerminalGuide } from "../guides.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Connect the computer the agent will run on. The user pastes a
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
          {/* No instruction line — the step title + why already cover what to
              do; the OS-specific "open Terminal / PowerShell" guidance lives
              under <ShowMeHow> below for users who need it. */}
          <CommandBox command={cliCommand} />
          {tokenError ? (
            <FlowNote>{tokenError}</FlowNote>
          ) : (
            <StatusRow state="waiting" label={COPY.connectComputer.waiting} />
          )}
          {stuck && <ConnectStuckPanel />}
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
