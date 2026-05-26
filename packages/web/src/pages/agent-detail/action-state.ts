import type { PresenceStatus } from "@first-tree/shared";
import type { HubClient } from "../../api/activity.js";
import type { ClientStatusInfo } from "../../api/agent-config.js";

export type AgentTestActionState = {
  disabled: boolean;
  title: string;
};

export function getAgentTestActionState(input: {
  agentStatus: string;
  clientStatus: ClientStatusInfo | undefined;
  clientStatusLoading: boolean;
  presenceStatus: PresenceStatus | null | undefined;
  testPending: boolean;
}): AgentTestActionState {
  if (input.agentStatus !== "active") {
    return { disabled: true, title: "Only active agents can be tested." };
  }
  if (input.clientStatusLoading) {
    return { disabled: true, title: "Checking the bound computer before testing." };
  }
  if (!input.clientStatus?.clientId) {
    return { disabled: true, title: "Bind a computer before testing this agent." };
  }
  // Reachability authority is `agent_presence.status`, surfaced as
  // `presenceStatus`. `clientStatus.online` is the underlying computer state;
  // a bound but unreachable agent (computer offline, stale heartbeat, etc.)
  // flips presenceStatus to "offline", so checking it here is the single
  // source of truth.
  if (input.presenceStatus !== "online") {
    return { disabled: true, title: "The bound computer is offline." };
  }
  if (input.testPending) {
    return { disabled: true, title: "Test in progress." };
  }
  return { disabled: false, title: "Send a test message to verify this agent can respond." };
}

export function isBindableClient(client: Pick<HubClient, "status">): boolean {
  return client.status === "connected";
}
