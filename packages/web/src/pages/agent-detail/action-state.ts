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
  runtimeState: string | null | undefined;
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
  // Reachability authority is `agent_presence.runtime_state` (M1+):
  // NULL means no runtime is reporting and the agent can't accept a test
  // message regardless of what `clientStatus.online` says about the
  // physical computer underneath. See `services/presence.ts` writers —
  // unbind / stale-cleanup clear `runtime_state` back to NULL.
  if (input.runtimeState == null) {
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
