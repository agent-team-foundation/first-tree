import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardMetaRow } from "./shared/card-meta-row.js";
import { PROVIDER_ORDER } from "./shared/providers.js";
import { RuntimeInstallBox } from "./shared/runtime-install-box.js";
import { cardHostnameLabel, SETUP_INCOMPLETE_DIAGNOSTIC, summarizeBoundAgents } from "./view-models.js";

type SetupIncompleteCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
};

/**
 * Variant B-2 body — connected machine with no runtime ready. Renders:
 *   - Diagnostic line + "install one of the following" framing
 *   - Per-provider install boxes (RuntimeInstallBox × N), side-by-side
 *     on wide cards, stacked on narrow ones
 *   - Compact agents summary if any are pinned (they'll be offline)
 *   - Heartbeat meta row at the bottom (NOT dimmed — the machine is
 *     online; meta is supporting but not stale)
 *
 * The boxes filter to non-`ok` runtimes only. If a runtime is `ok` here
 * the pill should not be `setup_incomplete` (by `deriveComputerStatus`
 * definition), so the filter is defensive against drift in the pill
 * rules.
 */
export function SetupIncompleteCardBody({ client, boundAgents, agentName }: SetupIncompleteCardBodyProps) {
  const hostname = cardHostnameLabel(client);
  const summary = summarizeBoundAgents(boundAgents);
  const installableProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p]?.state !== "ok");
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg)" }}>
        {SETUP_INCOMPLETE_DIAGNOSTIC}
      </p>
      <div
        style={{
          display: "grid",
          gap: "var(--sp-3)",
          // Side-by-side install boxes when the card is wide enough,
          // stacked 1-up below the breakpoint (17.5rem ≈ 280 baseline
          // for the install-command pre block).
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 17.5rem), 1fr))",
        }}
      >
        {installableProviders.map((provider) => (
          <RuntimeInstallBox
            key={provider}
            provider={provider}
            entry={client.capabilities[provider] ?? null}
            hostname={hostname}
          />
        ))}
      </div>
      {summary.total > 0 && <BoundAgentsList summary={summary} agentName={agentName} compact />}
      <CardMetaRow client={client} />
    </div>
  );
}
