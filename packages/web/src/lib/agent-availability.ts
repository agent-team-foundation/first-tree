import type { Agent } from "@first-tree/shared";
import { formatRelative } from "./utils.js";

export type AgentAvailabilityKind = "online" | "offline" | "needs-setup" | "suspended";

export type AgentAvailabilityView = {
  kind: AgentAvailabilityKind;
  label: string;
  detail: string | null;
};

export type AgentConnectionState = "online" | "offline";

/**
 * Derive the one availability statement shown on Team and Agent Detail.
 *
 * The product keeps lifecycle, connection, live work, and per-resource state
 * as separate data axes. This resolver intentionally collapses only the two
 * facts needed to answer "can this agent receive work?" into one user-facing
 * status. It is a presentation view, not a persisted health model.
 */
export function deriveAgentAvailability(input: {
  status: Agent["status"];
  clientId: string | null | undefined;
  connection: AgentConnectionState;
  clientLabel?: string | null;
  offlineSince?: string | null;
}): AgentAvailabilityView {
  if (input.status === "suspended") {
    return { kind: "suspended", label: "Suspended", detail: "Can’t receive new work." };
  }

  if (!input.clientId) {
    return { kind: "needs-setup", label: "Needs setup", detail: "No computer assigned." };
  }

  if (input.connection === "online") {
    return {
      kind: "online",
      label: "Online",
      detail: input.clientLabel ? `Connected to ${input.clientLabel}` : "Computer connected.",
    };
  }

  const relative = formatRelative(input.offlineSince);
  return {
    kind: "offline",
    label: "Offline",
    detail:
      relative === "—" ? "Computer connection unavailable." : `Computer connection unavailable · Last seen ${relative}`,
  };
}

/** Team has the lifecycle, pinned computer and runtime heartbeat on each row. */
export function deriveAgentDirectoryAvailability(agent: Agent): AgentAvailabilityView {
  return deriveAgentAvailability({
    status: agent.status,
    clientId: agent.clientId,
    connection: agent.runtimeState == null ? "offline" : "online",
    offlineSince: agent.lastSeenAt,
  });
}
