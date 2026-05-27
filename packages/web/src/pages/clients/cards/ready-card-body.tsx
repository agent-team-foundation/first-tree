import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import type { ReactNode } from "react";
import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
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
 * Variant A body — the happy path. Three groups separated by hairlines
 * inside the per-computer block:
 *   1. Heartbeat / first-tree / OS — `<dl>` field grid via `CardMetaRow`
 *   2. Runtimes — per-provider state line
 *   3. Bound agents — when ≥ 1
 *
 * Mockup §"Variant A" puts agents last. The Runtimes section is
 * informational (one runtime must be `ok` for the pill to be Ready) but
 * worth showing so the user sees at a glance whether they have both
 * runtimes or just one.
 */
export function ReadyCardBody({ client, boundAgents, agentName }: ReadyCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  return (
    <div className="flex flex-col">
      <Group>
        <CardMetaRow client={client} />
      </Group>
      <Group>
        <GroupLabel>Runtimes</GroupLabel>
        <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
          {PROVIDER_ORDER.map((provider) => (
            <RuntimeStateLine key={provider} provider={provider} entry={client.capabilities[provider] ?? null} />
          ))}
        </div>
      </Group>
      {summary.total > 0 && (
        <Group>
          <GroupLabel>{summary.total === 1 ? "Agent" : `Agents · ${summary.total}`}</GroupLabel>
          <BoundAgentsList summary={summary} agentName={agentName} headerless />
        </Group>
      )}
    </div>
  );
}

/**
 * Group inside a card body: stacks vertically with a hairline separator
 * on top. Keeps meta/runtimes/agents visually separated without nesting
 * boxes — same vocabulary `<Section>` uses for its top border.
 */
function Group({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col"
      style={{
        gap: "var(--sp-1_5)",
        padding: "var(--sp-2_5) 0",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      {children}
    </div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-caption" style={{ color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}

function RuntimeStateLine({ provider, entry }: { provider: RuntimeProvider; entry: CapabilityEntry | null }) {
  const label = PROVIDER_LABEL[provider];
  if (!entry) {
    return (
      <div className="text-body" style={{ color: "var(--fg-3)" }}>
        <span style={{ color: "var(--fg-2)" }}>{label}</span> · not reported · {PROVIDER_INSTALL_HINT[provider]}
      </div>
    );
  }
  switch (entry.state) {
    case "ok":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-idle)" }}>✓</span> {label}
          {entry.sdkVersion ? ` · v${entry.sdkVersion}` : ""} · authenticated ({entry.authMethod})
        </div>
      );
    case "unauthenticated":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-blocked)" }}>⚠</span> {label}
          {entry.sdkVersion ? ` v${entry.sdkVersion}` : ""}, not authenticated · {PROVIDER_UNAUTH_HINT[provider]}
        </div>
      );
    case "missing":
      return (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          <span style={{ color: "var(--fg-4)" }}>✗</span> {label} · not installed · {PROVIDER_INSTALL_HINT[provider]}
        </div>
      );
    case "error":
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-error)" }}>!</span> {label} · {entry.error ?? "probe failed"}
        </div>
      );
  }
}
