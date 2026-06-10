import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { listManagedAgents, type ManagedAgent } from "../../../api/agents.js";
import { Select } from "../../../components/ui/select.js";
import { writeOnboardingAgentUuid } from "../../../utils/onboarding-flags.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Recovery-only: choose which agent builds the Context Tree.
 *
 * In first-run onboarding the seed target is unambiguous (the agent the
 * create-agent step just made, stashed in sessionStorage). On a later
 * recovery that stash is gone and the org may now host several agents, so
 * `resolveOnboardingAgent` would silently fall back to "newest managed agent"
 * — possibly a reviewer bot or an invitee's agent. This panel makes the choice
 * explicit: it lists the admin's managed agents in this org, defaults to the
 * newest, and writes the pick into the same stash `resolveOnboardingAgent`
 * already prefers — so the kickoff core needs no change.
 */
export function BuildTreeAgentPanel({ onReady }: { onReady?: (ready: boolean) => void } = {}) {
  const { organizationId } = useOnboardingFlow();

  const agentsQuery = useQuery({
    queryKey: ["build-tree", "managed-agents", organizationId],
    queryFn: listManagedAgents,
    enabled: !!organizationId,
  });

  // Managed, non-human agents in THIS org, newest first (uuid v7 is
  // time-ordered, so a descending string sort puts the newest at the top).
  const candidates: ManagedAgent[] = (agentsQuery.data ?? [])
    .filter((a) => a.type !== "human" && a.organizationId === organizationId)
    .sort((a, b) => b.uuid.localeCompare(a.uuid));

  // Report whether a usable agent exists, so the kickoff step can disable
  // "Build tree & start" until there's an agent to seed with (clicking with no
  // agent would otherwise throw "No agent found" from resolveOnboardingAgent).
  const ready = agentsQuery.isSuccess && candidates.length > 0;
  useEffect(() => {
    onReady?.(ready);
  }, [ready, onReady]);

  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);

  // Default to the newest candidate once the list loads, and seed the stash so
  // an untouched picker still resolves to that agent at kickoff. Re-runs only
  // when the resolved default changes (not on every render).
  const defaultUuid = candidates[0]?.uuid ?? null;
  useEffect(() => {
    if (!defaultUuid) return;
    setSelectedUuid((cur) => cur ?? defaultUuid);
    writeOnboardingAgentUuid(defaultUuid);
  }, [defaultUuid]);

  const onChange = (uuid: string): void => {
    setSelectedUuid(uuid);
    writeOnboardingAgentUuid(uuid);
  };

  if (agentsQuery.isLoading) {
    return (
      <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
        Loading your agents…
      </p>
    );
  }

  if (candidates.length === 0) {
    // Shouldn't happen for an admin who finished onboarding (they created one),
    // but never render a dead end — point them at where agents are made.
    return (
      <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
        No agent to build the tree yet — create one from your team first.
      </p>
    );
  }

  const label = (a: ManagedAgent): string => a.displayName || a.name || a.uuid.slice(-6);
  // `null` once there's more than one candidate (then the picker shows); narrows
  // the `ManagedAgent | undefined` array access for the single-agent line.
  const sole = candidates.length === 1 ? candidates[0] : null;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
      <span className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
        Which agent should build the tree?
      </span>
      {sole ? (
        <p className="text-label" style={{ margin: 0, color: "var(--fg-3)" }}>
          {label(sole)} will draft your Context Tree.
        </p>
      ) : (
        <Select
          aria-label="Agent that builds the Context Tree"
          value={selectedUuid ?? defaultUuid ?? ""}
          onChange={onChange}
          options={candidates.map((a) => ({ value: a.uuid, label: label(a) }))}
        />
      )}
    </div>
  );
}
