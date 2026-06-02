import { ArrowRight, CircleAlert, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { STUCK_AFTER_MS } from "../../../components/connect-stuck-panel.js";
import { Button } from "../../../components/ui/button.js";
import { COPY } from "../copy.js";
import { CommandBox, StatusRow } from "../flow-ui.js";
import { ConnectTroubleshooting, ShowMeHow, TerminalGuide } from "../guides.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Connect the computer the agent will run on. The user pastes a one-liner into
 * a terminal; we poll until the computer shows up and confirm an AI coding
 * tool is ready on it. No "runtime"/"terminal-jockey" assumptions.
 *
 * Help is consolidated into a single "Need help?" disclosure (how-to +
 * troubleshooting). It auto-opens once the connect has been hanging a while, so
 * a stuck user gets help without hunting for it — and its label switches to
 * "Taking a while?" then. The required status (waiting / connected / no engine)
 * and the hard token-mint error stay inline; the error offers a Try again
 * (the hook also retries silently first, so most blips never surface).
 */
export function StepConnectComputer() {
  const { computer, goNext } = useOnboardingFlow();
  const { connectedClient, capabilitiesLoaded, okRuntimes, cliCommand, tokenError, retry } = computer;

  const noRuntime = !!connectedClient && capabilitiesLoaded && okRuntimes.length === 0;
  const ready = !!connectedClient && okRuntimes.length > 0;

  // Flip to "stuck" if the command doesn't connect within a reasonable window.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (connectedClient) {
      setStuck(false);
      return;
    }
    const t = window.setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [connectedClient]);

  // Auto-open the help once stuck; before that it stays collapsed (opt-in).
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (stuck) setHelpOpen(true);
  }, [stuck]);

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      {!connectedClient ? (
        <>
          <CommandBox command={cliCommand} />
          {tokenError ? (
            // Light, neutral treatment — not a saturated callout box. The state
            // is recoverable + usually transient, so a quiet line + a real
            // action button is calmer and clearer than a loud colored panel.
            <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <p
                className="inline-flex items-start text-label"
                role="alert"
                style={{ gap: "var(--sp-1_5)", margin: 0, color: "var(--fg-3)" }}
              >
                <CircleAlert
                  className="h-3.5 w-3.5"
                  style={{ flexShrink: 0, marginTop: "var(--sp-0_5)", color: "var(--fg-4)" }}
                  aria-hidden="true"
                />
                <span>{COPY.connectComputer.tokenErrorTitle}</span>
              </p>
              <Button type="button" variant="outline" onClick={retry} className="self-start">
                {COPY.connectComputer.retry}
              </Button>
            </div>
          ) : (
            <StatusRow state="waiting" label={COPY.connectComputer.waiting} />
          )}
          <ShowMeHow
            label={stuck ? COPY.connectComputer.helpStuckLabel : undefined}
            open={helpOpen}
            onToggle={setHelpOpen}
          >
            <TerminalGuide />
            <ConnectTroubleshooting />
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
            // Light treatment, consistent with the token-error state — a quiet
            // line + icon, not a saturated callout box. The disabled Continue
            // already signals "one more thing before you can move on".
            <p
              className="inline-flex items-start text-label"
              style={{ gap: "var(--sp-1_5)", margin: 0, color: "var(--fg-3)" }}
            >
              <Info
                className="h-3.5 w-3.5"
                style={{ flexShrink: 0, marginTop: "var(--sp-0_5)", color: "var(--fg-4)" }}
                aria-hidden="true"
              />
              <span>{COPY.connectComputer.noRuntime}</span>
            </p>
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
