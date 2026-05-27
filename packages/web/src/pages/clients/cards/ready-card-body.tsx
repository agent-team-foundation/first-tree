import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { UppercaseLabel } from "../../../components/ui/section-header.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardMetaRow } from "./shared/card-meta-row.js";
import { PROVIDER_INSTALL_HINT, PROVIDER_LABEL, PROVIDER_ORDER, PROVIDER_UNAUTH_HINT } from "./shared/providers.js";
import { summarizeBoundAgents } from "./view-models.js";

type ReadyCardBodyProps = {
  client: HubClient;
  boundAgents: RuntimeAgent[];
  agentName: (uuid: string | null | undefined) => string;
};

/**
 * Variant A body — the happy path. Renders:
 *   - Heartbeat / first-tree / OS meta row
 *   - Runtimes section: per-provider state line (✓ / ⚠ / ⊘)
 *   - Bound agents: full list with PresenceChips
 *
 * Mockup §"Variant A" puts the agents section last. The Runtimes
 * matrix on a Ready card is informational (one runtime is `ok` by
 * definition — that's why the pill is Ready) but worth showing so the
 * user can see at a glance whether they're running both Claude Code
 * and Codex, or only one.
 */
export function ReadyCardBody({ client, boundAgents, agentName }: ReadyCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      <CardMetaRow client={client} />
      <RuntimesSection capabilities={client.capabilities} />
      <BoundAgentsList summary={summary} agentName={agentName} />
    </div>
  );
}

/**
 * Compact Runtimes section for Ready cards. Same vocabulary as the
 * pre-PR-B `ProviderRow` (under the table's expanded row) but rendered
 * unconditionally inline. Reused so the visual hint colors stay
 * consistent across the page.
 */
function RuntimesSection({ capabilities }: { capabilities: HubClient["capabilities"] }) {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
      <UppercaseLabel style={{ display: "block", marginBottom: 4 }}>Runtimes</UppercaseLabel>
      <div className="flex flex-col gap-1">
        {PROVIDER_ORDER.map((provider) => (
          <RuntimeStateLine key={provider} provider={provider} entry={capabilities[provider] ?? null} />
        ))}
      </div>
    </div>
  );
}

function RuntimeStateLine({ provider, entry }: { provider: RuntimeProvider; entry: CapabilityEntry | null }) {
  const label = PROVIDER_LABEL[provider];
  if (!entry) {
    return (
      <div className="flex items-center gap-2.5 text-body" style={{ opacity: 0.7 }}>
        <span className="font-medium" style={{ minWidth: 140 }}>
          {label}
        </span>
        <span className="text-caption" style={{ color: "var(--fg-4)" }}>
          not reported · {PROVIDER_INSTALL_HINT[provider]}
        </span>
      </div>
    );
  }
  switch (entry.state) {
    case "ok":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--state-idle)" }}>
            ✓ {entry.sdkVersion ? `v${entry.sdkVersion} · ` : ""}authenticated ({entry.authMethod})
          </span>
        </div>
      );
    case "unauthenticated":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--state-blocked)" }}>
            ⚠ installed{entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}, not authenticated ·{" "}
            {PROVIDER_UNAUTH_HINT[provider]}
          </span>
        </div>
      );
    case "missing":
      return (
        <div className="flex items-center gap-2.5 text-body" style={{ opacity: 0.7 }}>
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--fg-4)" }}>
            ✗ not installed · {PROVIDER_INSTALL_HINT[provider]}
          </span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-center gap-2.5 text-body">
          <span className="font-medium" style={{ minWidth: 140 }}>
            {label}
          </span>
          <span className="text-caption" style={{ color: "var(--state-error)" }}>
            error · {entry.error ?? "probe failed"}
          </span>
        </div>
      );
  }
}
