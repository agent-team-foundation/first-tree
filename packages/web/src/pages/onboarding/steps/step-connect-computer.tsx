import { RUNTIME_PROVIDERS, type RuntimeProvider } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { STUCK_AFTER_MS } from "../../../components/connect-stuck-panel.js";
import { Button } from "../../../components/ui/button.js";
import { OptionCard } from "../../../components/ui/option-card.js";
import { PROVIDER_LABEL } from "../../clients/cards/shared/providers.js";
import { COPY } from "../copy.js";
import { CommandBox, FlowHint, StatusRow } from "../flow-ui.js";
import { ConnectTroubleshooting, ShowMeHow, TerminalGuide } from "../guides.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

const KNOWN_RUNTIME_PROVIDERS: readonly string[] = Object.values(RUNTIME_PROVIDERS);

/**
 * Narrow a wire-string provider to the shared `RuntimeProvider` enum before
 * handing it to `PROVIDER_LABEL`. Mirrors the guard in
 * `clients/cards/shared/bound-agents-list.tsx` — recognised providers get the
 * shared display, anything truly unknown is dropped rather than leaked raw.
 */
function asRuntimeProvider(provider: string): RuntimeProvider | null {
  // Single `as` after an includes-guard, matching the accepted pattern in
  // bound-agents-list / new-agent-dialog (the enum has no runtime type guard).
  return KNOWN_RUNTIME_PROVIDERS.includes(provider) ? (provider as RuntimeProvider) : null;
}

/** Friendly runtime label, falling back to the raw id if it's not a known one. */
function runtimeLabel(provider: string): string {
  const known = asRuntimeProvider(provider);
  return known ? PROVIDER_LABEL[known] : provider;
}

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
export function StepConnectComputer({ initialStuck = false }: { initialStuck?: boolean } = {}) {
  const { computer, goNext } = useOnboardingFlow();
  const {
    connectedClient,
    capabilitiesLoaded,
    okRuntimes,
    selectedRuntime,
    setSelectedRuntime,
    cliCommand,
    tokenError,
    retry,
  } = computer;

  const noRuntime = !!connectedClient && capabilitiesLoaded && okRuntimes.length === 0;
  const ready = !!connectedClient && okRuntimes.length > 0;

  // Ready runtimes narrowed to the shared enum, for the single-select pills.
  // (≥2 → pick one; exactly one → just confirm it.)
  const okProviders = okRuntimes.flatMap((p) => {
    const provider = asRuntimeProvider(p);
    return provider ? [provider] : [];
  });

  // Flip to "stuck" if the command doesn't connect within a reasonable window.
  // `initialStuck` lets the DEV preview render the stuck state directly (the
  // real timer takes STUCK_AFTER_MS); production never passes it.
  const [stuck, setStuck] = useState(initialStuck);
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
      {/* State-aware subtitle (the shell's static `why` is empty for this step):
          "run the command below" only holds while waiting; once connected we
          swap to a neutral line so it doesn't reference a command that's gone. */}
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        {connectedClient ? COPY.connectComputer.whyConnected : COPY.connectComputer.whyWaiting}
      </p>
      {!connectedClient ? (
        <>
          <CommandBox command={cliCommand} />
          {tokenError ? (
            // Light treatment — recoverable + usually transient, so a quiet
            // line + a real action button, not a loud colored panel.
            <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              <FlowHint tone="error" role="alert">
                {COPY.connectComputer.tokenErrorTitle}
              </FlowHint>
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
            <TerminalGuide command={cliCommand} />
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
            // Light treatment, consistent with the rest — the disabled Continue
            // already signals "one more thing before you can move on".
            <FlowHint>{COPY.connectComputer.noRuntime}</FlowHint>
          ) : okProviders.length <= 1 ? (
            // Exactly one runtime detected — nothing to choose, so name it and
            // confirm the agent will use it.
            <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
              {COPY.connectComputer.runtimeReady(runtimeLabel(selectedRuntime ?? okRuntimes[0] ?? ""))}
            </p>
          ) : (
            // Two or more — count + a single-select list. Defaults to the
            // auto-picked runtime; clicking a pill re-points `selectedRuntime`,
            // which create-agent then uses as the agent's runtimeProvider.
            <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
              <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
                {COPY.connectComputer.runtimesReady(okProviders.length)}
              </p>
              <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
                {okProviders.map((provider) => (
                  <OptionCard
                    key={provider}
                    name="onboarding-runtime"
                    layout="pill"
                    checked={selectedRuntime === provider}
                    onSelect={() => setSelectedRuntime(provider)}
                  >
                    <span className="text-body">{PROVIDER_LABEL[provider]}</span>
                  </OptionCard>
                ))}
              </div>
            </div>
          )}
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
