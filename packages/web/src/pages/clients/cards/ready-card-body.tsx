import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import type { ReactNode } from "react";
import type { HubClient, RuntimeAgent } from "../../../api/activity.js";
import { BoundAgentsList } from "./shared/bound-agents-list.js";
import { CardMetaRow } from "./shared/card-meta-row.js";
import { PROVIDER_LABEL, PROVIDER_ORDER, providerInstallHint, providerUnauthHint } from "./shared/providers.js";
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
 *   2. Runtimes — per-provider state line (filtered to reported runtimes)
 *   3. Bound agents — when ≥ 1
 *
 * Mockup §"Variant A" puts agents last. The Runtimes section is
 * informational (one runtime must be `ok` for the pill to be Ready)
 * but worth showing so the user sees at a glance whether they have
 * both runtimes or just one.
 *
 * Runtimes the SDK never reported (`entry === null`) are *not*
 * rendered — they'd otherwise be a "not reported · Install …" advert
 * for a runtime the user actively chose not to install. The fully-
 * empty case is owned by the Setup-incomplete pill, which has its own
 * install boxes.
 */
export function ReadyCardBody({ client, boundAgents, agentName }: ReadyCardBodyProps) {
  const summary = summarizeBoundAgents(boundAgents);
  const reportedProviders = PROVIDER_ORDER.filter((p) => client.capabilities[p] != null);
  return (
    <div className="flex flex-col">
      <Group>
        <CardMetaRow client={client} />
      </Group>
      {reportedProviders.length > 0 && (
        <Group>
          <GroupLabel>Runtimes</GroupLabel>
          <div className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
            {reportedProviders.map((provider) => {
              const entry = client.capabilities[provider];
              if (entry == null) return null;
              return <RuntimeStateLine key={provider} provider={provider} entry={entry} os={client.os} />;
            })}
          </div>
        </Group>
      )}
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

/**
 * Per-runtime state line. All states render with a leading status
 * glyph and the provider label as the first segment, then peer
 * mid-dot-separated segments for version / state-or-method. Action
 * hints (login / install) come after a period as a separate sentence
 * so they don't crowd the segment rhythm.
 *
 * `entry === null` (not-yet-reported) is filtered upstream — this
 * function assumes a real capability snapshot.
 */
function RuntimeStateLine({
  provider,
  entry,
  os,
}: {
  provider: RuntimeProvider;
  entry: CapabilityEntry;
  os: string | null;
}) {
  const label = PROVIDER_LABEL[provider];
  switch (entry.state) {
    case "ok": {
      // authMethod (`oauth` / `auth_json` / `api_key`) is implementation
      // detail — users care that the runtime is reachable, not *how*
      // it's authed. The ✓ glyph already conveys "authenticated". If
      // troubleshooting needs the method later, it's still in the
      // wire response and reachable via /agent/:id.
      const segments = [label, entry.sdkVersion ? `v${entry.sdkVersion}` : null].filter(Boolean) as string[];
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-idle)" }}>✓</span> {segments.join(" · ")}
        </div>
      );
    }
    case "unauthenticated": {
      const segments = [label, entry.sdkVersion ? `v${entry.sdkVersion}` : null, "unauthenticated"].filter(
        Boolean,
      ) as string[];
      return (
        <div className="text-body" style={{ color: "var(--fg-2)" }}>
          <span style={{ color: "var(--state-blocked)" }}>⚠</span> {segments.join(" · ")}.{" "}
          <span style={{ color: "var(--fg-3)" }}>{providerUnauthHint(provider, os)}</span>
        </div>
      );
    }
    case "missing":
      return (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          <span style={{ color: "var(--fg-4)" }}>✗</span> {label} · not installed. {providerInstallHint(provider, os)}
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
