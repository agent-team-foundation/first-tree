import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { CommandBox, FlowNote, StatusRow } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Connect the computer the AI teammate will run on. The user pastes a
 * one-liner into a terminal; we poll until the computer shows up and we
 * confirm an AI runtime is ready on it. No "runtime" jargon — if none is
 * ready we say so in plain words and tell them what to install.
 */
export function StepConnectComputer() {
  const { computer, goNext } = useOnboardingFlow();
  const { connectedClient, capabilitiesLoaded, okRuntimes, cliCommand, tokenError } = computer;

  const noRuntime = !!connectedClient && capabilitiesLoaded && okRuntimes.length === 0;
  const ready = !!connectedClient && okRuntimes.length > 0;

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
